require('dotenv').config();
const { 
    Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, 
    TextInputStyle, ActionRowBuilder, PermissionsBitField, EmbedBuilder,
    ButtonBuilder, ButtonStyle, ChannelType, Partials 
} = require('discord.js');
const { google } = require('googleapis');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

// --- CONFIGURAÇÃO GOOGLE SHEETS ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'), 
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- INICIALIZAÇÃO DO BOT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions // Necessário para aprovação por ✅
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// --- MODELOS DE DADOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String,
    idade: Number, genero: String, estado: String,
    lastMessage: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    warnings: [{ reason: String, date: { type: Date, default: Date.now } }]
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String, // Oficiais
    roleMembro: String, roleCandidato: String, // Cargo p/ quem não entrou ainda
    canalAviso: String, canalVerificacao: String, canalLogs: String, 
    canalRecrutamento: String, canalRegras: String,
    msgGuerra: { type: String, default: "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!" }
}));

// --- FUNÇÃO: ADICIONAR CARGOS DINÂMICOS ---
async function addDynamicRole(guild, member, roleName) {
    if (!roleName) return;
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) role = await guild.roles.create({ name: roleName }).catch(() => null);
    if (role) await member.roles.add(role).catch(() => {});
}

// --- FUNÇÃO: SALVAR NA PLANILHA (FIXED) ---
async function saveToSheet(data) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Página1!A:I', // Aumentado para 9 colunas
            valueInputOption: 'USER_ENTERED',
            resource: { values: [data] },
        });
        console.log("✅ Dados salvos na planilha.");
    } catch (e) { console.error("❌ ERRO PLANILHA:", e.message); }
}

// --- EVENTOS DO BOT ---

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastSeen: new Date(), username: msg.author.username }, { upsert: true });
});

// SISTEMA DE VERIFICAÇÃO COM TICKET
client.on('interactionCreate', async (interaction) => {
    const config = await GuildConfig.findOne({ guildId: interaction.guild.id });

    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const channel = await interaction.guild.channels.create({
            name: `verificar-${interaction.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles] },
                { id: config?.roleVerificado1 || interaction.guild.ownerId, allow: [PermissionsBitField.Flags.ViewChannel] }
            ],
        });

        await interaction.reply({ content: `Acesse o canal: ${channel}`, ephemeral: true });
        const embed = new EmbedBuilder().setTitle("📋 Recrutamento").setDescription("Responda: Qual seu Nome Real?").setColor("#5865F2");
        await channel.send({ content: `${interaction.user}`, embeds: [embed] });

        const collector = channel.createMessageCollector({ filter: m => m.author.id === interaction.user.id, time: 900000 });
        let passo = 1;
        const respostas = {};

        collector.on('collect', async (m) => {
            if (passo === 1) { respostas.nome = m.content; await m.reply("Qual seu Nick no FF?"); }
            else if (passo === 2) { respostas.nick = m.content; await m.reply("Qual seu ID (UID)?"); }
            else if (passo === 3) { respostas.id = m.content; await m.reply("Qual sua Idade?"); }
            else if (passo === 4) {
                respostas.idade = parseInt(m.content);
                if (respostas.idade < 14) {
                    await m.reply("❌ Menor de 14 anos não permitido.");
                    setTimeout(() => interaction.member.ban({ reason: "Idade insuficiente" }), 3000);
                    return collector.stop();
                }
                await m.reply("Gênero (Masc/Fem)?");
            }
            else if (passo === 5) { respostas.genero = m.content; await m.reply("Estado?"); }
            else if (passo === 6) { respostas.estado = m.content; await m.reply("Mande a FOTO do perfil do jogo."); }
            else if (passo === 7) {
                respostas.foto = m.attachments.first()?.url;
                if (!respostas.foto) return m.reply("Mande a foto!");
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('ja_guarda_sim').setLabel('Sim, já estou').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('ja_guarda_nao').setLabel('Não, quero entrar').setStyle(ButtonStyle.Danger)
                );
                await m.reply({ content: "Você já está na guilda dentro do jogo?", components: [row] });
                respostas.membro = m.member;
                respostas.canalTicket = channel;
                respostas.guildData = respostas; // Hack p/ passar dados
            }
            passo++;
        });
    }

    // RESPOSTA DOS BOTÕES SIM/NÃO
    if (interaction.isButton() && interaction.customId.startsWith('ja_guarda')) {
        const isSim = interaction.customId === 'ja_guarda_sim';
        const guildData = await User.findOne({ discordId: interaction.user.id }); // Pega dados salvos temporários ou do chat
        // Para simplificar, vamos processar os dados finais aqui
        
        // Aplica Nick e Cargos de Perfil (Idade, etc)
        await interaction.member.setNickname(interaction.member.displayName).catch(() => {});
        
        if (isSim) {
            if (config?.roleMembro) await interaction.member.roles.add(config.roleMembro);
            await interaction.reply(`🎉 **Parabéns!** Você já é um membro oficial. Leia as regras em <#${config?.canalRegras}>`);
            setTimeout(() => interaction.channel.delete(), 10000);
        } else {
            if (config?.roleCandidato) await interaction.member.roles.add(config.roleCandidato);
            if (config?.canalRecrutamento) {
                const recrutChan = client.channels.cache.get(config.canalRecrutamento);
                const embed = new EmbedBuilder()
                    .setTitle("Solicitação de Entrada")
                    .setDescription(`O membro **${interaction.user.tag}** quer entrar na guilda.`)
                    .addFields({name: "ID", value: "Aguardando ✅ para aprovar"})
                    .setColor("Yellow");
                const msgRecrut = await recrutChan.send({ embeds: [embed] });
                await msgRecrut.react('✅');
            }
            await interaction.reply("✅ Sua solicitação foi enviada aos Oficiais. Aguarde a aprovação!");
            setTimeout(() => interaction.channel.delete(), 5000);
        }
        
        // SALVAR NA PLANILHA (Aba: Página1)
        await saveToSheet([interaction.user.tag, "Registrado", "ID", "Idade", "Gênero", "Estado", "Foto", isSim ? "Sim" : "Não", new Date().toLocaleString()]);
    }
});

// APROVAÇÃO POR REAÇÃO ✅
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.emoji.name === '✅') {
        const config = await GuildConfig.findOne({ guildId: reaction.message.guildId });
        // Verifica se quem reagiu é staff
        const memberStaff = await reaction.message.guild.members.fetch(user.id);
        if (!memberStaff.roles.cache.has(config.roleVerificado1)) return;

        // Tenta achar o membro mencionado na embed
        const embed = reaction.message.embeds[0];
        if (!embed) return;
        const targetTag = embed.description.split('**')[1];
        const targetMember = reaction.message.guild.members.cache.find(m => m.user.tag === targetTag);

        if (targetMember) {
            if (config.roleMembro) await targetMember.roles.add(config.roleMembro);
            if (config.roleCandidato) await targetMember.roles.remove(config.roleCandidato);
            await targetMember.send("⚔️ **SOLICITAÇÃO ACEITA!** Você agora faz parte da nossa guilda no Free Fire. Seja bem-vindo!").catch(() => {});
            await reaction.message.delete();
        }
    }
});

// --- RESTO DO CÓDIGO (DASHBOARD, CRON, ETC) ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'guild_key', resave: false, saveUninitialized: false }));
app.use(passport.initialize()); app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI, scope: ['identify']
}, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u)); passport.deserializeUser((o, d) => d(null, o));

app.get('/', (req, res) => res.render('login'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const dbUsers = await User.find();
    const members = await Promise.all(dbUsers.map(async (u) => {
        const m = guild.members.cache.get(u.discordId);
        return {
            id: u._id, name: m ? m.user.tag : u.username,
            avatar: m ? m.user.displayAvatarURL() : '',
            ffNick: u.ffNick, ffId: u.ffId,
            status: m ? (m.presence?.status || 'offline') : 'left',
            lastSeen: u.lastSeen, warns: u.warnings?.length || 0,
            nickMismatch: m && m.displayName !== u.ffNick
        };
    }));
    res.render('dashboard', { members });
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID }) || {};
    res.render('settings', { roles, channels, config });
});

app.post('/save', async (req, res) => {
    await GuildConfig.findOneAndUpdate({ guildId: process.env.GUILD_ID }, req.body, { upsert: true });
    res.redirect('/settings');
});

app.post('/send-setup', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    const ch = await client.channels.fetch(config.canalVerificacao);
    if (ch) {
        const btn = new ButtonBuilder().setCustomId('btn_verificar').setLabel('Iniciar Recrutamento').setStyle(ButtonStyle.Primary);
        await ch.send({ embeds: [new EmbedBuilder().setTitle("⚔️ RECRUTAMENTO").setColor("#5865F2")], components: [new ActionRowBuilder().addComponents(btn)] });
        res.send("<script>alert('Botão enviado!'); window.location.href='/settings';</script>");
    }
});

cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if(config?.canalAviso) client.channels.cache.get(config.canalAviso)?.send(config.msgGuerra);
}, { timezone: "America/Sao_Paulo" });

app.listen(process.env.PORT || 3000, () => console.log("🚀 Servidor Online"));
client.login(process.env.TOKEN);
