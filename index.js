require('dotenv').config();
const { 
    Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, 
    TextInputStyle, ActionRowBuilder, PermissionsBitField, EmbedBuilder,
    ButtonBuilder, ButtonStyle 
} = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

// --- INICIALIZAÇÃO DO BOT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences // Necessário para o "Online agora"
    ]
});

// --- CONEXÃO BANCO DE DADOS ---
mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// --- MODELOS DE DADOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, 
    username: String, 
    ffNick: String, 
    ffId: String, 
    lastMessage: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    warnings: [{ reason: String, date: { type: Date, default: Date.now } }]
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String,
    roleNovato: String,
    roleVerificado1: String,
    roleVerificado2: String,
    canalAviso: String,
    canalVerificacao: String,
    msgGuerra: { type: String, default: "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!" }
}));

// --- LÓGICA DO BOT ---

// Atualiza quando o usuário manda mensagem
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate(
        { discordId: msg.author.id }, 
        { lastMessage: new Date(), lastSeen: new Date(), username: msg.author.username }, 
        { upsert: true }
    );
});

// Atualiza o "Visto por último" quando o status muda
client.on('presenceUpdate', async (oldP, newP) => {
    if (!newP || !newP.userId) return;
    await User.findOneAndUpdate({ discordId: newP.userId }, { lastSeen: new Date() }, { upsert: true });
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Registro Free Fire');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel("Nick no FF").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ffid').setLabel("Seu ID (UID)").setStyle(TextInputStyle.Short).setRequired(true))
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
            // Criar cargo de UID
            const roleName = `UID: ${ffid}`;
            let roleUID = interaction.guild.roles.cache.find(r => r.name === roleName);
            if (!roleUID) roleUID = await interaction.guild.roles.create({ name: roleName });
            await interaction.member.roles.add(roleUID);

            await User.findOneAndUpdate(
                { discordId: interaction.user.id },
                { ffNick: nick, ffId: ffid, username: interaction.user.username, lastSeen: new Date() },
                { upsert: true }
            );
            await interaction.reply({ content: "✅ Registro concluído!", ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: "Erro: Verifique as permissões do Bot.", ephemeral: true });
        }
    }
});

// GUERRA DE SÁBADO 16H
cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (config?.canalAviso) {
        const channel = client.channels.cache.get(config.canalAviso);
        if (channel) channel.send(config.msgGuerra);
    }
}, { timezone: "America/Sao_Paulo" });

// --- SERVIDOR WEB ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'guild_ff_key', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI, scope: ['identify']
}, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((o, d) => d(null, o));

// --- ROTAS DO SITE ---

// ROTA PRINCIPAL (O QUE ESTAVA FALTANDO)
app.get('/', (req, res) => {
    res.render('login');
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const dbUsers = await User.find();
    
    const members = await Promise.all(dbUsers.map(async (u) => {
        const m = guild.members.cache.get(u.discordId);
        return {
            id: u._id,
            name: m ? m.user.tag : u.username + " (SAIU)",
            avatar: m ? m.user.displayAvatarURL() : 'https://cdn.discordapp.com/embed/avatars/0.png',
            ffNick: u.ffNick,
            ffId: u.ffId,
            status: m ? (m.presence?.status || 'offline') : 'left',
            lastSeen: u.lastSeen,
            warns: u.warnings.length,
            nickMismatch: m && m.displayName !== u.ffNick
        };
    }));
    res.render('dashboard', { members });
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
        const embed = new EmbedBuilder().setTitle("🛡️ Registro de Membros").setDescription("Clique abaixo para registrar seu ID.").setColor("#5865F2");
        await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
        res.send("<script>alert('Botão enviado!'); window.location.href='/settings';</script>");
    }
});

app.post('/warn/:id', async (req, res) => {
    const { reason } = req.body;
    await User.findByIdAndUpdate(req.params.id, { $push: { warnings: { reason: reason || "Inatividade", date: new Date() } } });
    res.redirect('/dashboard');
});

app.post('/clear-warns/:id', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { $set: { warnings: [] } });
    res.redirect('/dashboard');
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Servidor Online"));
client.login(process.env.TOKEN);
