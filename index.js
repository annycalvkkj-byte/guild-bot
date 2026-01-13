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
    intents: [3276799],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

mongoose.connect(process.env.MONGO_URI);

// --- MODELOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String,
    idade: Number, genero: String, estado: String, fotoUrl: String,
    guildaAlvo: String, // "I" ou "II"
    lastSeen: { type: Date, default: Date.now },
    warnings: [{ reason: String, evidence: String, date: { type: Date, default: Date.now } }]
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String,
    roleMembro: String, roleCandidato: String, canalAviso: String, 
    canalVerificacao: String, canalLogs: String, canalRecrutamento: String, 
    canalRegras: String, canalPunicao: String, msgGuerra: String,
    // NOVOS CAMPOS
    roleGuilda1: String, roleGuilda2: String,
    guilda1Full: { type: Boolean, default: false },
    guilda2Full: { type: Boolean, default: false },
    avisarGuerra: { type: Boolean, default: true }
}));

// --- FUNÇÃO: APLICAR CARGOS ---
async function applyCargosRecrutamento(guild, member, data, config) {
    const cargos = [
        { name: data.genero, color: data.genero?.toLowerCase() === 'masculino' ? '#3498db' : '#e91e63' },
        { name: data.estado, color: '#95a5a6' },
        { name: `Idade: ${data.idade}`, color: '#95a5a6' },
        { name: `UID: ${data.ffId}`, color: '#95a5a6' }
    ];

    // Cargo da Guilda I ou II
    if (data.guildaAlvo === 'I' && config.roleGuilda1) await member.roles.add(config.roleGuilda1).catch(()=>{});
    if (data.guildaAlvo === 'II' && config.roleGuilda2) await member.roles.add(config.roleGuilda2).catch(()=>{});

    for (const c of cargos) {
        if (!c.name) continue;
        let role = guild.roles.cache.find(r => r.name.toLowerCase() === c.name.toLowerCase());
        if (!role) {
            role = await guild.roles.create({ name: c.name, color: c.color, reason: 'Auto-Cargos' }).catch(()=>{});
        }
        if (role) await member.roles.add(role).catch(()=>{});
    }
}

async function saveToSheet(tab, values) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:L`,
            valueInputOption: 'USER_ENTERED', resource: { values: [values] },
        });
    } catch (e) { console.error("Erro Planilha:", e.message); }
}

client.on('ready', () => console.log("🤖 Bot pronto!"));

// --- COMANDO DE LIMPAR MENSAGENS ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith('!clear')) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
        const args = message.content.split(' ');
        const amount = parseInt(args[1]);
        if (isNaN(amount) || amount < 1 || amount > 100) return message.reply("Digite um número de 1 a 100.");
        await message.channel.bulkDelete(amount + 1, true);
        const msg = await message.channel.send(`✅ **${amount}** mensagens apagadas.`);
        setTimeout(() => msg.delete(), 3000);
    }
});

// --- SISTEMA DE RECRUTAMENTO ---
client.on('interactionCreate', async (i) => {
    const config = await GuildConfig.findOne({ guildId: i.guildId });

    if (i.isButton() && i.customId === 'btn_verificar') {
        const chan = await i.guild.channels.create({
            name: `recrut-${i.user.username}`,
            permissionOverwrites: [
                { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles] }
            ]
        });

        await i.reply({ content: `Iniciado: ${chan}`, ephemeral: true });
        await chan.send({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 1").setDescription("Qual seu Nome Real?").setColor("#5865F2")] });

        const col = chan.createMessageCollector({ filter: m => m.author.id === i.user.id, time: 900000 });
        let p = 1; const res = { id: i.user.id, tag: i.user.tag };

        col.on('collect', async (m) => {
            if (p === 1) { res.nome = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 2").setDescription("Nick no FF?").setColor("#5865F2")] }); }
            else if (p === 2) { res.nick = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 3").setDescription("ID (UID)?").setColor("#5865F2")] }); }
            else if (p === 3) {
                if(isNaN(m.content)) return m.reply("Apenas números!");
                res.uid = m.content;
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 4").setDescription("Sua Idade?").setColor("#5865F2")] });
            }
            else if (p === 4) {
                res.idade = parseInt(m.content);
                if (res.idade < 14) { await m.reply("Menor de 14 banido."); return i.member.ban({ reason: "Idade" }); }
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 5").setDescription("Gênero (Masculino/Feminino)?").setColor("#5865F2")] });
            }
            else if (p === 5) { res.genero = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 6").setDescription("Seu Estado?").setColor("#5865F2")] }); }
            else if (p === 6) { res.estado = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 7").setDescription("Mande a FOTO do perfil.").setColor("#5865F2")] }); }
            else if (p === 7) {
                res.foto = m.attachments.first()?.url;
                if (!res.foto) return m.reply("Mande a foto!");

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('sim_ta').setLabel('Sim, já estou na Guilda').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('nao_ta').setLabel('Não estou ainda').setStyle(ButtonStyle.Danger)
                );
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🏁 Quase lá").setDescription("Você já está em uma de nossas Guildas?").setColor("#5865F2")], components: [row] });
                col.stop();
            }
            p++;
        });
    }

    // BOTÕES: JÁ ESTÁ NA GUILDA?
    if (i.isButton() && (i.customId === 'sim_ta' || i.customId === 'nao_ta')) {
        const sim = i.customId === 'sim_ta';
        const rowGuilds = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(sim ? 'set_g1_ja' : 'set_g1_rec').setLabel('GUILDA I').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(sim ? 'set_g2_ja' : 'set_g2_rec').setLabel('GUILDA II').setStyle(ButtonStyle.Secondary)
        );
        await i.update({ embeds: [new EmbedBuilder().setTitle("⚔️ Escolha a Guilda").setDescription(sim ? "Em qual guilda você já está?" : "Em qual guilda você deseja entrar?").setColor("#5865F2")], components: [rowGuilds] });
    }

    // LOGICA DE GUILDA I OU II
    if (i.isButton() && i.customId.startsWith('set_g')) {
        const guilda = i.customId.includes('g1') ? 'I' : 'II';
        const isJaEstou = i.customId.endsWith('ja');
        const isFull = guilda === 'I' ? config.guilda1Full : config.guilda2Full;

        if (!isJaEstou && isFull) {
            return i.update({ embeds: [new EmbedBuilder().setTitle("❌ Guilda Lotada").setDescription(`Sinto muito, a **GUILDA ${guilda}** está cheia no momento. Escolha outra ou aguarde vagas.`).setColor("Red")], components: [] });
        }

        // Salva dados no Mongo
        const userData = await User.findOneAndUpdate({ discordId: i.user.id }, { guildaAlvo: guilda }, { upsert: true, new: true });

        if (isJaEstou) {
            await i.member.roles.add(config.roleMembro).catch(()=>{});
            await applyCargosRecrutamento(i.guild, i.member, { genero: userData.genero, estado: userData.estado, idade: userData.idade, ffId: userData.ffId, guildaAlvo: guilda }, config);
            await i.update({ embeds: [new EmbedBuilder().setTitle("🎉 Bem-vindo Oficial").setDescription(`Você foi registrado na **GUILDA ${guilda}**! Leia as regras em <#${config.canalRegras}>`).setColor("Green")], components: [] });
        } else {
            await i.member.roles.add(config.roleCandidato).catch(()=>{});
            const recrutChan = client.channels.cache.get(config.canalRecrutamento);
            if (recrutChan) {
                const emb = new EmbedBuilder().setTitle("Solicitação").setDescription(`Membro: ${i.user.tag}\nAlvo: **GUILDA ${guilda}**\nID Discord: ${i.user.id}`).setColor("Orange");
                const msg = await recrutChan.send({ embeds: [emb] }); await msg.react('✅');
            }
            await i.update({ embeds: [new EmbedBuilder().setTitle("✅ Enviado").setDescription(`Sua solicitação para a **GUILDA ${guilda}** foi enviada aos Oficiais.`).setColor("Blue")], components: [] });
        }
        setTimeout(() => i.channel.delete().catch(()=>{}), 5000);
    }
});

// APROVAÇÃO ✅
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== '✅') return;
    const config = await GuildConfig.findOne({ guildId: reaction.message.guildId });
    const discordId = reaction.message.embeds[0].description.split('ID Discord: ')[1];
    const member = await reaction.message.guild.members.fetch(discordId);
    const userData = await User.findOne({ discordId: discordId });

    if (userData && member) {
        await member.roles.add(config.roleMembro).catch(()=>{});
        await member.roles.remove(config.roleCandidato).catch(()=>{});
        await applyCargosRecrutamento(reaction.message.guild, member, { genero: userData.genero, estado: userData.estado, idade: userData.idade, ffId: userData.ffId, guildaAlvo: userData.guildaAlvo }, config);
        await member.send({ embeds: [new EmbedBuilder().setTitle("⚔️ Aprovado!").setDescription(`Sua entrada na **GUILDA ${userData.guildaAlvo}** foi aceita!`).setColor("Green")] }).catch(()=>{});
        await reaction.message.delete();
    }
});

// GUERRA SÁBADO
cron.schedule('0 16 * * 6', async () => {
    const configs = await GuildConfig.find({ avisarGuerra: true });
    configs.forEach(c => {
        const ch = client.channels.cache.get(c.canalAviso);
        if (ch) ch.send(c.msgGuerra || "@everyone ⚔️ Guerra começou!");
    });
}, { timezone: "America/Sao_Paulo" });

// --- DASHBOARD E ROTAS WEB ---
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
        return { id: u._id, name: m.user.tag, avatar: m.user.displayAvatarURL(), ffNick: u.ffNick, ffId: u.ffId, status: m.presence?.status || 'offline', lastSeen: u.lastSeen, warns: u.warnings?.length || 0 };
    }))).filter(m => m !== null);
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
    // Tratamento para Checkboxes (se não marcado, vem undefined)
    const data = {
        ...req.body,
        guilda1Full: req.body.guilda1Full === 'on',
        guilda2Full: req.body.guilda2Full === 'on',
        avisarGuerra: req.body.avisarGuerra === 'on'
    };
    await GuildConfig.findOneAndUpdate({ guildId: process.env.GUILD_ID }, data, { upsert: true });
    res.redirect('/settings');
});

app.post('/send-setup', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    const ch = await client.channels.fetch(config.canalVerificacao);
    const btn = new ButtonBuilder().setCustomId('btn_verificar').setLabel('Iniciar Recrutamento').setStyle(ButtonStyle.Primary);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("⚔️ RECRUTAMENTO").setColor("Blue")], components: [new ActionRowBuilder().addComponents(btn)] });
    res.redirect('/settings');
});

app.listen(process.env.PORT || 3000, () => console.log("Site Online"));
client.login(process.env.TOKEN);
