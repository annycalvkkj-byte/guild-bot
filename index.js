require('dotenv').config();
const { 
    Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, 
    TextInputStyle, ActionRowBuilder, PermissionsBitField, EmbedBuilder,
    ButtonBuilder, ButtonStyle, Presence 
} = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences // NECESSÁRIO PARA TEMPO REAL
    ]
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// --- MODELOS DE DADOS ATUALIZADOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, 
    username: String, 
    ffNick: String, 
    ffId: String, 
    lastMessage: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now }, // Para o "Online há..."
    warnings: [{ reason: String, date: { type: Date, default: Date.now } }] // Punições
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String, roleVerificado2: String,
    canalAviso: String, canalVerificacao: String, msgGuerra: String
}));

// --- LÓGICA DO BOT ---

// Monitorar quando o usuário fica online/offline
client.on('presenceUpdate', async (oldP, newP) => {
    if (!newP.userId) return;
    await User.findOneAndUpdate({ discordId: newP.userId }, { lastSeen: new Date() }, { upsert: true });
});

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastMessage: new Date(), lastSeen: new Date(), username: msg.author.username }, { upsert: true });
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Dados do Free Fire');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel("Nick no FF").setStyle(1).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ffid').setLabel("Seu ID (UID)").setStyle(1).setRequired(true))
        );
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_ff') {
        const nick = interaction.fields.getTextInputValue('nick');
        const ffid = interaction.fields.getTextInputValue('ffid');
        const config = await GuildConfig.findOne({ guildId: interaction.guild.id });
        try {
            await interaction.member.setNickname(nick).catch(() => {});
            if (config) {
                if (config.roleNovato) await interaction.member.roles.remove(config.roleNovato).catch(() => {});
                if (config.roleVerificado1) await interaction.member.roles.add(config.roleVerificado1).catch(() => {});
                if (config.roleVerificado2) await interaction.member.roles.add(config.roleVerificado2).catch(() => {});
            }
            const roleName = `UID: ${ffid}`;
            let r = interaction.guild.roles.cache.find(x => x.name === roleName);
            if (!r) r = await interaction.guild.roles.create({ name: roleName });
            await interaction.member.roles.add(r);
            await User.findOneAndUpdate({ discordId: interaction.user.id }, { ffNick: nick, ffId: ffid, username: interaction.user.username }, { upsert: true });
            await interaction.reply({ content: "✅ Registrado!", ephemeral: true });
        } catch (e) { await interaction.reply({ content: "Erro de permissão!", ephemeral: true }); }
    }
});

// SERVIDOR WEB
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'guild_ff_key', resave: false, saveUninitialized: false }));
app.use(passport.initialize()); app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI, scope: ['identify']
}, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u)); passport.deserializeUser((o, d) => d(null, o));

// ROTA DASHBOARD (LISTA EM TEMPO REAL)
app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const dbUsers = await User.find();
    
    const members = await Promise.all(dbUsers.map(async (u) => {
        const m = guild.members.cache.get(u.discordId);
        return {
            id: u._id,
            discordId: u.discordId,
            name: m ? m.user.tag : u.username + " (SAIU)",
            avatar: m ? m.user.displayAvatarURL() : 'https://cdn.discordapp.com/embed/avatars/0.png',
            ffNick: u.ffNick,
            ffId: u.ffId,
            status: m ? (m.presence?.status || 'offline') : 'left',
            lastSeen: u.lastSeen,
            warns: u.warnings.length,
            nickMismatch: m && m.displayName !== u.ffNick // Checagem de Nick
        };
    }));
    res.render('dashboard', { members });
});

// ROTA PARA APLICAR ADVERTÊNCIA
app.post('/warn/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    const { reason } = req.body;
    await User.findByIdAndUpdate(req.params.id, { 
        $push: { warnings: { reason: reason || "Sem motivo", date: new Date() } } 
    });
    res.redirect('/dashboard');
});

// ROTA PARA LIMPAR ADVERTÊNCIAS
app.post('/clear-warns/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    await User.findByIdAndUpdate(req.params.id, { $set: { warnings: [] } });
    res.redirect('/dashboard');
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const roles = guild.roles.cache.filter(r => r.name !== "@everyone").map(r => ({ id: r.id, name: r.name }));
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
    const channel = await client.channels.fetch(config.canalVerificacao);
    if (channel) {
        const btn = new ButtonBuilder().setCustomId('btn_verificar').setLabel('Verificar-se na Guilda').setStyle(ButtonStyle.Primary);
        await channel.send({ embeds: [new EmbedBuilder().setTitle("🛡️ Registro").setColor("#5865F2")], components: [new ActionRowBuilder().addComponents(btn)] });
        res.send("<script>alert('Enviado!'); window.location.href='/settings';</script>");
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Online"));
client.login(process.env.TOKEN);
