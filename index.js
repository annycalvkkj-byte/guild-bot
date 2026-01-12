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

// --- CONFIGURAÇÃO GOOGLE SHEETS (VIA ENV) ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'), 
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// --- INICIALIZAÇÃO DO BOT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// --- MODELOS DE DADOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, 
    username: String, 
    ffNick: String, 
    ffId: String,
    idade: Number,
    genero: String,
    estado: String,
    fotoUrl: String,
    lastMessage: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    warnings: [{ reason: String, date: { type: Date, default: Date.now } }]
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String,
    roleNovato: String,
    roleVerificado1: String, // Cargo de Oficiais/Staff
    roleMembro: String,      // Cargo Membro Verificado
    canalAviso: String,
    canalVerificacao: String,
    canalLogs: String,
    msgGuerra: { type: String, default: "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!" }
}));

// --- FUNÇÃO: ADICIONAR CARGOS SEM REPETIR ---
async function addDynamicRole(guild, member, roleName) {
    if (!roleName) return;
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
        role = await guild.roles.create({ 
            name: roleName, 
            reason: 'Criação automática via verificação' 
        }).catch(() => null);
    }
    if (role) await member.roles.add(role).catch(() => {});
}

// --- FUNÇÃO: SALVAR NA PLANILHA ---
async function saveToSheet(data) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Página1!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [data] },
        });
    } catch (e) { console.error("Erro Planilha:", e.message); }
}

// --- EVENTOS DO BOT ---

client.on('ready', () => console.log(`🤖 Bot ${client.user.tag} operando.`));

// Registrar Atividade
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastMessage: new Date(), lastSeen: new Date(), username: msg.author.username }, { upsert: true });
});

client.on('presenceUpdate', async (oldP, newP) => {
    if (!newP?.userId) return;
    await User.findOneAndUpdate({ discordId: newP.userId }, { lastSeen: new Date() }, { upsert: true });
});

// SISTEMA DE TICKET E VERIFICAÇÃO
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

        await interaction.reply({ content: `Canal criado: ${channel}`, ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle("📋 Ficha de Recrutamento")
            .setDescription("Responda as perguntas abaixo no chat.\n\n**1.** Qual seu Nome Real?")
            .setColor("#5865F2");

        await channel.send({ content: `${interaction.user} <@&${config?.roleVerificado1}>`, embeds: [embed] });

        const collector = channel.createMessageCollector({ filter: m => m.author.id === interaction.user.id, time: 900000 });
        let passo = 1;
        const respostas = { userTag: interaction.user.tag };

        collector.on('collect', async (m) => {
            if (passo === 1) { respostas.nome = m.content; await m.reply("**2.** Qual seu Nick no Free Fire?"); }
            else if (passo === 2) { respostas.nick = m.content; await m.reply("**3.** Qual seu ID (UID) do jogo?"); }
            else if (passo === 3) { respostas.ffId = m.content; await m.reply("**4.** Qual sua Idade? (Apenas números)"); }
            else if (passo === 4) {
                respostas.idade = parseInt(m.content);
                if (respostas.idade < 14) {
                    await m.reply("❌ **BANIDO:** Você possui menos de 14 anos.");
                    setTimeout(() => interaction.member.ban({ reason: "Menor de 14 anos" }), 3000);
                    return collector.stop();
                }
                await m.reply("**5.** Qual seu Gênero? (Masculino/Feminino)");
            }
            else if (passo === 5) { respostas.genero = m.content; await m.reply("**6.** Qual seu Estado?"); }
            else if (passo === 6) { respostas.estado = m.content; await m.reply("**7.** Mande agora a **FOTO** do seu perfil no jogo."); }
            else if (passo === 7) {
                respostas.foto = m.attachments.first()?.url;
                if (!respostas.foto) return m.reply("❌ Envie uma foto!");

                await m.reply("⏳ Processando dados...");
                const member = interaction.member;

                // 1. Nickname
                await member.setNickname(respostas.nick).catch(() => {});
                
                // 2. Cargos Fixos
                if (config?.roleMembro) await member.roles.add(config.roleMembro);
                if (config?.roleNovato) await member.roles.remove(config.roleNovato);

                // 3. Cargos Dinâmicos
                await addDynamicRole(interaction.guild, member, `Idade: ${respostas.idade}`);
                await addDynamicRole(interaction.guild, member, respostas.genero);
                await addDynamicRole(interaction.guild, member, respostas.estado);
                await addDynamicRole(interaction.guild, member, `UID: ${respostas.ffId}`);

                // 4. Salvar MongoDB
                await User.findOneAndUpdate({ discordId: member.id }, { 
                    ffNick: respostas.nick, ffId: respostas.ffId, idade: respostas.idade, 
                    genero: respostas.genero, estado: respostas.estado, fotoUrl: respostas.foto,
                    username: interaction.user.tag
                }, { upsert: true });

                // 5. Salvar Planilha
                await saveToSheet([respostas.nome, respostas.nick, respostas.ffId, respostas.idade, respostas.genero, respostas.estado, respostas.foto, new Date().toLocaleString()]);

                // 6. Logs
                if (config?.canalLogs) {
                    const logEmbed = new EmbedBuilder().setTitle("Nova Ficha").setImage(respostas.foto).setColor("Green")
                        .addFields(
                            {name: "Nick", value: respostas.nick, inline: true},
                            {name: "UID", value: respostas.ffId, inline: true},
                            {name: "Idade", value: `${respostas.idade}`, inline: true}
                        );
                    client.channels.cache.get(config.canalLogs).send({ embeds: [logEmbed] });
                }

                await channel.send("✅ Verificação finalizada! Este canal sumirá em 10s.");
                setTimeout(() => channel.delete().catch(() => {}), 10000);
                collector.stop();
            }
            passo++;
        });
    }
});

// AVISO DE GUERRA
cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (config?.canalAviso) {
        const ch = client.channels.cache.get(config.canalAviso);
        if (ch) ch.send(config.msgGuerra);
    }
}, { timezone: "America/Sao_Paulo" });

// --- DASHBOARD WEB ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'ff_secret', resave: false, saveUninitialized: false }));
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
            avatar: m ? m.user.displayAvatarURL() : 'https://cdn.discordapp.com/embed/avatars/0.png',
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
        const btn = new ButtonBuilder().setCustomId('btn_verificar').setLabel('Iniciar Verificação').setStyle(ButtonStyle.Primary);
        await ch.send({ 
            embeds: [new EmbedBuilder().setTitle("🛡️ Registro").setDescription("Clique no botão abaixo para iniciar seu recrutamento.").setColor("#5865F2")], 
            components: [new ActionRowBuilder().addComponents(btn)] 
        });
        res.send("<script>alert('Enviado!'); window.location.href='/settings';</script>");
    }
});

app.post('/warn/:id', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { $push: { warnings: { reason: req.body.reason || "Inatividade", date: new Date() } } });
    res.redirect('/dashboard');
});

app.post('/clear-warns/:id', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { $set: { warnings: [] } });
    res.redirect('/dashboard');
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Servidor Web Online"));
client.login(process.env.TOKEN);
