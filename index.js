require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

// --- SCHEMAS DO BANCO DE DATA ---
const userSchema = new mongoose.Schema({
    discordId: String,
    username: String,
    ffNick: String,
    ffId: String,
    lastMessage: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const configSchema = new mongoose.Schema({
    guildId: String,
    roleNovato: String,
    roleVerificado1: String,
    roleVerificado2: String,
    canalAviso: String,
    msgGuerra: { type: String, default: "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!" }
});
const GuildConfig = mongoose.model('GuildConfig', configSchema);

// --- INICIALIZAÇÃO ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// --- LÓGICA DO BOT ---

// Comando !setup para criar o botão
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastMessage: new Date(), username: msg.author.username }, { upsert: true });

    if (msg.content === '!setup' && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const row = new ActionRowBuilder().addComponents({ type: 2, label: 'Verificar-se', style: 1, customId: 'verificar' });
        msg.channel.send({ content: "**🛡️ SISTEMA DE VERIFICAÇÃO**\nClique no botão para entrar na guilda.", components: [row] });
    }
});

// Interações (Botão e Modal)
client.on('interactionCreate', async (i) => {
    if (i.isButton() && i.customId === 'verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Cadastro FF');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel('Nick no FF').setStyle(TextInputStyle.Short)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id_ff').setLabel('ID do FF').setStyle(TextInputStyle.Short))
        );
        return i.showModal(modal);
    }

    if (i.isModalSubmit() && i.customId === 'modal_ff') {
        const nick = i.fields.getTextInputValue('nick');
        const id_ff = i.fields.getTextInputValue('id_ff');
        const config = await GuildConfig.findOne({ guildId: i.guild.id });

        try {
            await i.member.setNickname(nick);
            if (config?.roleNovato) await i.member.roles.remove(config.roleNovato).catch(() => {});
            if (config?.roleVerificado1) await i.member.roles.add(config.roleVerificado1).catch(() => {});
            if (config?.roleVerificado2) await i.member.roles.add(config.roleVerificado2).catch(() => {});
            
            // Criar cargo de UID
            const roleUID = await i.guild.roles.create({ name: `UID: ${id_ff}` });
            await i.member.roles.add(roleUID);

            await User.findOneAndUpdate({ discordId: i.user.id }, { ffNick: nick, ffId: id_ff }, { upsert: true });
            i.reply({ content: "✅ Verificado!", ephemeral: true });
        } catch (e) { i.reply({ content: "❌ Erro nas permissões do Bot.", ephemeral: true }); }
    }
});

// Aviso de Guerra Sábado 16h
cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (config?.canalAviso) {
        const channel = client.channels.cache.get(config.canalAviso);
        if (channel) channel.send(config.msgGuerra);
    }
}, { timezone: "America/Sao_Paulo" });

// --- SITE (DASHBOARD) ---
const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI, scope: ['identify', 'guilds']
}, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((o, d) => d(null, o));

app.get('/', (req, res) => res.send('<a href="/auth/discord">Login via Discord</a>'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const users = await User.find();
    res.render('dashboard', { users });
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

app.listen(process.env.PORT, () => console.log("🚀 Site Online"));
client.login(process.env.TOKEN);
