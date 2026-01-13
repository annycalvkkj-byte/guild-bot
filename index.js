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

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// --- MODELOS ---
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

// --- FUNÇÃO: APLICAR CARGOS (DINÂMICO E COLORIDO) ---
async function applyCargosRecrutamento(guild, member, data) {
    if (!data) return console.log("❌ Erro: Dados não encontrados para aplicar cargos.");

    const cargos = [
        { name: data.genero, color: data.genero?.toLowerCase() === 'masculino' ? '#3498db' : '#e91e63' },
        { name: data.estado, color: '#95a5a6' },
        { name: `Idade: ${data.idade}`, color: '#95a5a6' },
        { name: `UID: ${data.ffId}`, color: '#95a5a6' }
    ];

    for (const c of cargos) {
        if (!c.name) continue;
        let role = guild.roles.cache.find(r => r.name.toLowerCase() === c.name.toLowerCase());
        
        if (!role) {
            role = await guild.roles.create({
                name: c.name,
                color: c.color,
                reason: 'Criação automática - Recrutamento'
            }).catch(e => console.log(`Erro ao criar cargo ${c.name}:`, e.message));
        }
        
        if (role) await member.roles.add(role).catch(e => console.log(`Erro ao dar cargo ${c.name}:`, e.message));
    }
}

// --- FUNÇÃO: SALVAR NA PLANILHA ---
async function saveToSheet(tab, values) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${tab}!A:K`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [values] },
        });
        console.log(`✅ Salvo na planilha: ${tab}`);
    } catch (e) { console.error(`❌ Erro Planilha (${tab}):`, e.message); }
}

client.on('ready', () => console.log("🚀 Bot Online e Sincronizado!"));

// --- SISTEMA DE TICKET ---
client.on('interactionCreate', async (i) => {
    const config = await GuildConfig.findOne({ guildId: i.guildId });

    if (i.isButton() && i.customId === 'btn_verificar') {
        const chan = await i.guild.channels.create({
            name: `recrut-${i.user.username}`,
            permissionOverwrites: [
                { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles] },
                { id: config?.roleVerificado1, allow: [PermissionsBitField.Flags.ViewChannel] }
            ]
        });

        await i.reply({ content: `Acesse seu ticket: ${chan}`, ephemeral: true });
        await chan.send({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 1").setDescription("Qual seu Nome Real?").setColor("#5865F2")] });

        const col = chan.createMessageCollector({ filter: m => m.author.id === i.user.id, time: 900000 });
        let p = 1; const res = { id: i.user.id, tag: i.user.tag };

        col.on('collect', async (m) => {
            if (p === 1) { res.nome = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 2").setDescription("Qual seu Nick no FF?").setColor("#5865F2")] }); }
            else if (p === 2) { res.nick = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 3").setDescription("Qual seu ID (UID)? (Apenas números)").setColor("#5865F2")] }); }
            else if (p === 3) {
                if(isNaN(m.content)) return m.reply("❌ Digite apenas números no ID!");
                res.uid = m.content;
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 4").setDescription("Qual sua Idade?").setColor("#5865F2")] });
            }
            else if (p === 4) {
                res.idade = parseInt(m.content);
                if (res.idade < 14) { await m.reply("❌ Banido: Menor de 14 anos."); return i.member.ban({ reason: "Idade" }); }
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 5").setDescription("Qual seu Gênero (Masculino/Feminino)?").setColor("#5865F2")] });
            }
            else if (p === 5) { res.genero = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 6").setDescription("Qual seu Estado?").setColor("#5865F2")] }); }
            else if (p === 6) { res.estado = m.content; await m.reply({ embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 7").setDescription("Mande a FOTO do perfil do jogo (Print).").setColor("#5865F2")] }); }
            else if (p === 7) {
                res.foto = m.attachments.first()?.url;
                if (!res.foto) return m.reply("❌ Envie a foto!");

                // Salva no MongoDB primeiro
                await User.findOneAndUpdate({ discordId: i.user.id }, { 
                    ffNick: res.nick, ffId: res.uid, idade: res.idade, genero: res.genero, estado: res.estado, fotoUrl: res.foto, username: i.user.tag 
                }, { upsert: true });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('sim_ta').setLabel('Já estou na Guilda').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('nao_ta').setLabel('Não estou ainda').setStyle(ButtonStyle.Danger)
                );
                await m.reply({ embeds: [new EmbedBuilder().setTitle("🏁 Finalizar").setDescription("Você já está na guilda dentro do jogo?").setColor("#5865F2")], components: [row] });
                
                // Tenta salvar na planilha, mas não trava o bot se falhar
                saveToSheet('Respostas', [res.id, res.tag, res.nome, res.nick, res.uid, res.idade, res.genero, res.estado, res.foto, "PENDENTE", new Date().toLocaleString()]);
                col.stop();
            }
            p++;
        });
    }

    // --- REPOSTA SIM/NÃO ---
    if (i.isButton() && (i.customId === 'sim_ta' || i.customId === 'nao_ta')) {
        const userData = await User.findOne({ discordId: i.user.id });
        const sim = i.customId === 'sim_ta';

        if (sim) {
            await i.member.setNickname(userData.ffNick).catch(()=>{});
            await i.member.roles.add(config.roleMembro).catch(()=>{});
            await applyCargosRecrutamento(i.guild, i.member, userData);
            await i.reply({ embeds: [new EmbedBuilder().setTitle("🎉 Bem-vindo!").setDescription("Você agora é membro oficial!").setColor("Green")] });
        } else {
            await i.member.roles.add(config.roleCandidato).catch(()=>{});
            const recrutChan = client.channels.cache.get(config.canalRecrutamento);
            if (recrutChan) {
                const msg = await recrutChan.send({ embeds: [new EmbedBuilder().setTitle("Solicitação").setDescription(`Membro: ${i.user.tag}\nID Discord: ${i.user.id}`).setColor("Orange")] });
                await msg.react('✅');
            }
            await i.reply("Sua ficha foi enviada para análise!");
        }
        setTimeout(() => i.channel.delete().catch(()=>{}), 5000);
    }
});

// --- APROVAÇÃO ✅ ---
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== '✅') return;
    const config = await GuildConfig.findOne({ guildId: reaction.message.guildId });
    const embed = reaction.message.embeds[0];
    if (!embed) return;
    
    const discordId = embed.description.split('ID Discord: ')[1];
    const member = await reaction.message.guild.members.fetch(discordId).catch(() => null);
    const userData = await User.findOne({ discordId: discordId });

    if (member && userData) {
        await member.setNickname(userData.ffNick).catch(()=>{});
        await member.roles.add(config.roleMembro).catch(()=>{});
        await member.roles.remove(config.roleCandidato).catch(()=>{});
        
        // Aplica os cargos (Idade, UID, etc)
        await applyCargosRecrutamento(reaction.message.guild, member, userData);
        
        await member.send({ embeds: [new EmbedBuilder().setTitle("⚔️ Aprovado!").setColor("Green")] }).catch(()=>{});
        await reaction.message.delete().catch(()=>{});
    }
});

// --- DASHBOARD E SITE ---
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
            lastSeen: u.lastSeen, warns: u.warnings?.length || 0, nickMismatch: m.displayName !== u.ffNick
        };
    }))).filter(m => m !== null);
    res.render('dashboard', { members });
});

app.get('/punishments', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    // Tenta puxar da planilha para o histórico
    let history = [];
    try {
        const resSheet = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Punições!A:H' });
        history = resSheet.data.values || [];
    } catch(e) {}
    const members = await User.find();
    res.render('punishments', { history, members });
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
        
        saveToSheet('Punições', [new Date().toLocaleString(), member.user.tag, discordId, type.toUpperCase(), reason, evidence, time || 'PERM', req.user.username]);

        const ch = client.channels.cache.get(config.canalPunicao);
        if (ch) ch.send({ embeds: [new EmbedBuilder().setTitle("🚨 PUNIÇÃO").setDescription(`Membro: ${member.user.tag}\nTipo: ${type}\nMotivo: ${reason}`).setColor("Red")] });
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
    await ch.send({ embeds: [new EmbedBuilder().setTitle("⚔️ RECRUTAMENTO").setColor("Blue")], components: [new ActionRowBuilder().addComponents(btn)] });
    res.redirect('/settings');
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Servidor Web Online"));
client.login(process.env.TOKEN);
