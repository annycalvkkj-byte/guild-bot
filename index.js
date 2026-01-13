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

// --- GOOGLE AUTH CONFIG ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

mongoose.connect(process.env.MONGO_URI);

// --- MODELOS DE DADOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String,
    idade: Number, genero: String, estado: String, fotoUrl: String,
    lastSeen: { type: Date, default: Date.now },
    warnings: [{ reason: String, evidence: String, date: { type: Date, default: Date.now } }]
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String,
    roleMembro: String, roleCandidato: String, canalAviso: String, 
    canalVerificacao: String, canalLogs: String, canalRecrutamento: String, 
    canalRegras: String, canalPunicao: String, msgGuerra: String
}));

// --- FUNÇÃO: SETUP PLANILHA ---
async function setupSheet() {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const tabs = meta.data.sheets.map(s => s.properties.title);
        if (!tabs.includes('Respostas')) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: 'Respostas' } } }] } });
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: 'Respostas!A1:K1', valueInputOption: 'USER_ENTERED', resource: { values: [["ID Discord", "Tag", "Nome", "Nick FF", "UID", "Idade", "Gênero", "Estado", "Foto", "Já na Guilda?", "Data"]] } });
        }
        if (!tabs.includes('Punições')) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: 'Punições' } } }] } });
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: 'Punições!A1:H1', valueInputOption: 'USER_ENTERED', resource: { values: [["Data", "Membro", "ID Discord", "Tipo", "Motivo", "Evidência", "Tempo", "Staff"]] } });
        }
    } catch (e) { console.log("Erro Planilha:", e.message); }
}

// --- FUNÇÃO: CARGOS COM CORES ---
async function addColoredRole(guild, member, roleName) {
    if (!roleName) return;
    let color = "#95a5a6";
    const n = roleName.toLowerCase();
    if (n === "masculino") color = "#3498db";
    if (n === "feminino") color = "#e91e63";
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === n);
    if (!role) role = await guild.roles.create({ name: roleName, color: color, reason: 'Recrutamento' });
    await member.roles.add(role).catch(() => {});
}

client.on('ready', async () => { await setupSheet(); console.log("Bot Online!"); });

// --- LÓGICA DE RECRUTAMENTO ---
client.on('interactionCreate', async (i) => {
    const config = await GuildConfig.findOne({ guildId: i.guildId });
    if (i.isButton() && i.customId === 'btn_verificar') {
        const chan = await i.guild.channels.create({
            name: `recrut-${i.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles] },
                { id: config?.roleVerificado1, allow: [PermissionsBitField.Flags.ViewChannel] }
            ]
        });
        await i.reply({ content: `Canal criado: ${chan}`, ephemeral: true });

        const embedP1 = new EmbedBuilder().setTitle("🛡️ Pergunta 1").setDescription("Qual seu Nome Real?").setColor("#5865F2");
        await chan.send({ content: `${i.user}`, embeds: [embedP1] });

        const col = chan.createMessageCollector({ filter: m => m.author.id === i.user.id, time: 900000 });
        let p = 1; const res = { id: i.user.id, tag: i.user.tag };

        col.on('collect', async (m) => {
            if (p === 1) { res.nome = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 2").setDescription("Qual seu Nick no FF?").setColor("#5865F2")] }); }
            else if (p === 2) { res.nick = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 3").setDescription("Qual seu ID (UID)?\n*Apenas números são permitidos.*").setColor("#5865F2")] }); }
            else if (p === 3) { 
                if (isNaN(m.content)) return m.reply("❌ **ERRO:** O ID deve conter apenas números! Digite novamente.");
                res.uid = m.content; 
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 4").setDescription("Qual sua Idade?").setColor("#5865F2")] }); 
            }
            else if (p === 4) {
                res.idade = parseInt(m.content);
                if (res.idade < 14) { await m.reply("❌ **BANIDO:** Menor de 14 anos não permitido."); return i.member.ban({ reason: "Idade < 14" }); }
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 5").setDescription("Qual seu Gênero (Masculino/Feminino)?").setColor("#5865F2")] });
            }
            else if (p === 5) { res.genero = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 6").setDescription("Qual seu Estado?").setColor("#5865F2")] }); }
            else if (p === 6) { res.estado = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 7").setDescription("Mande a **FOTO** do perfil do jogo (Print).").setColor("#5865F2")] }); }
            else if (p === 7) {
                res.foto = m.attachments.first()?.url;
                if (!res.foto) return m.reply("❌ Envie a foto para prosseguir!");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('sim_ta').setLabel('Já estou na Guilda').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('nao_ta').setLabel('Não estou ainda').setStyle(ButtonStyle.Danger)
                );
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🏁 Último Passo").setDescription("Você já está na guilda dentro do jogo?").setColor("#5865F2")], components: [row] });
                
                // Salvar provisório na planilha
                await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Respostas!A:K', valueInputOption: 'USER_ENTERED', resource: { values: [[res.id, res.tag, res.nome, res.nick, res.uid, res.idade, res.genero, res.estado, res.foto, "PENDENTE", new Date().toLocaleString()]] } });
                col.stop();
            }
            p++;
        });
    }

    if (i.isButton() && (i.customId === 'sim_ta' || i.customId === 'nao_ta')) {
        const sim = i.customId === 'sim_ta';
        if (sim) {
            await i.member.roles.add(config.roleMembro).catch(() => {});
            await i.reply({ embeds: [new EmbedBuilder().setTitle("🎉 Bem-vindo Oficial").setDescription(`Você agora é um membro registrado! Leia as regras em <#${config.canalRegras}>`).setColor("Green")] });
        } else {
            await i.member.roles.add(config.roleCandidato).catch(() => {});
            const rChan = client.channels.cache.get(config.canalRecrutamento);
            if (rChan) {
                const emb = new EmbedBuilder().setTitle("⚔️ Nova Solicitação").setDescription(`O membro **${i.user.tag}** enviou uma ficha.\nID Discord: ${i.user.id}`).setColor("Orange");
                const msg = await rChan.send({ embeds: [emb] }); await msg.react('✅');
            }
            await i.reply({ embeds: [new EmbedBuilder().setTitle("✅ Enviado").setDescription("Sua ficha foi enviada aos Oficiais. Aguarde aprovação!").setColor("Blue")] });
        }
        setTimeout(() => i.channel.delete().catch(() => {}), 5000);
    }
});

// APROVAÇÃO ✅
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== '✅') return;
    const config = await GuildConfig.findOne({ guildId: reaction.message.guildId });
    const discordId = reaction.message.embeds[0].description.split('ID Discord: ')[1];
    const member = await reaction.message.guild.members.fetch(discordId);
    const resSheet = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Respostas!A:K' });
    const data = resSheet.data.values.find(r => r[0] === discordId);

    if (data && member) {
        const [id, tag, nome, nick, uid, idade, genero, estado] = data;
        await member.setNickname(nick).catch(()=>{});
        await member.roles.add(config.roleMembro);
        await member.roles.remove(config.roleCandidato).catch(()=>{});

        // APLICAR CARGOS DINÂMICOS (GÊNERO COM COR)
        await addColoredRole(reaction.message.guild, member, genero);
        await addColoredRole(reaction.message.guild, member, estado);
        await addColoredRole(reaction.message.guild, member, `Idade: ${idade}`);
        await addColoredRole(reaction.message.guild, member, `UID: ${uid}`);

        await member.send({ embeds: [new EmbedBuilder().setTitle("⚔️ Aprovado").setDescription("Sua solicitação para entrar na guilda foi aceita!").setColor("Green")] }).catch(()=>{});
        await reaction.message.delete();
    }
});

// --- SERVIDOR WEB ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'ff', resave: false, saveUninitialized: false }));
app.use(passport.initialize()); app.use(passport.session());

passport.use(new DiscordStrategy({ clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET, callbackURL: process.env.REDIRECT_URI, scope: ['identify'] }, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u)); passport.deserializeUser((o, d) => d(null, o));

app.get('/', (req, res) => res.render('login'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const dbUsers = await User.find();
    const members = (await Promise.all(dbUsers.map(async (u) => {
        const m = guild.members.cache.get(u.discordId);
        if (!m) return null;
        return {
            id: u._id, name: m.user.tag, avatar: m.user.displayAvatarURL(),
            ffNick: u.ffNick, ffId: u.ffId, status: m.presence?.status || 'offline',
            lastSeen: u.lastSeen, warns: u.warnings?.length || 0,
            nickMismatch: m.displayName !== u.ffNick
        };
    }))).filter(m => m !== null);
    res.render('dashboard', { members });
});

app.get('/punishments', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const resSheet = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Punições!A:H' });
    const members = await User.find();
    res.render('punishments', { history: resSheet.data.values || [], members });
});

app.post('/punish', async (req, res) => {
    const { discordId, type, reason, evidence, time } = req.body;
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const member = await guild.members.fetch(discordId).catch(() => null);
    const config = await GuildConfig.findOne({ guildId: guild.id });
    if (member) {
        if (type === 'mute') await member.timeout(time * 60000, reason);
        if (type === 'kick') await member.kick(reason);
        if (type === 'ban') await member.ban({ reason });
        await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Punições!A:H', valueInputOption: 'USER_ENTERED', resource: { values: [[new Date().toLocaleString(), member.user.tag, discordId, type.toUpperCase(), reason, evidence, time || 'PERM', req.user.username]] } });
        const ch = client.channels.cache.get(config.canalPunicao);
        if (ch) {
            const punEmbed = new EmbedBuilder().setTitle("🚨 NOVA PUNIÇÃO").setColor("Red")
                .addFields(
                    { name: "👤 Membro", value: member.user.tag, inline: true },
                    { name: "⚖️ Tipo", value: type.toUpperCase(), inline: true },
                    { name: "📝 Motivo", value: reason },
                    { name: "🔗 Evidência", value: evidence || "Não fornecida" }
                );
            ch.send({ embeds: [punEmbed] });
        }
    }
    res.redirect('/punishments');
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID }) || {};
    res.render('settings', { roles, channels, config });
});

app.post('/save', async (req, res) => { await GuildConfig.findOneAndUpdate({ guildId: process.env.GUILD_ID }, req.body, { upsert: true }); res.redirect('/settings'); });

app.post('/send-setup', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    const ch = await client.channels.fetch(config.canalVerificacao);
    const btn = new ButtonBuilder().setCustomId('btn_verificar').setLabel('Iniciar Recrutamento').setStyle(ButtonStyle.Primary);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("⚔️ RECRUTAMENTO").setDescription("Clique no botão abaixo para iniciar seu processo de entrada.").setColor("Blue")], components: [new ActionRowBuilder().addComponents(btn)] });
    res.redirect('/settings');
});

app.listen(process.env.PORT || 3000, () => console.log("Site Online"));
client.login(process.env.TOKEN);
