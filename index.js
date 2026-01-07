require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

mongoose.connect(process.env.MONGO_URI);

const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String, lastMessage: { type: Date, default: Date.now }
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String, roleVerificado2: String, canalAviso: String, msgGuerra: String
}));

// --- BOT EVENTS ---
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastMessage: new Date(), username: msg.author.username }, { upsert: true });
    if (msg.content === '!setup' && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const row = new ActionRowBuilder().addComponents({ type: 2, label: 'Verificar-se na Guilda', style: 1, customId: 'verificar' });
        msg.channel.send({ content: "### 🛡️ Registro de Membros\nClique no botão abaixo para registrar seu ID e Nick.", components: [row] });
    }
});

client.on('interactionCreate', async (i) => {
    if (i.isButton() && i.customId === 'verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Registro Free Fire');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel('Nick no FF').setStyle(1)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id_ff').setLabel('Seu ID (UID)').setStyle(1))
        );
        await i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'modal_ff') {
        const nick = i.fields.getTextInputValue('nick');
        const id_ff = i.fields.getTextInputValue('id_ff');
        const config = await GuildConfig.findOne({ guildId: i.guild.id });
        try {
            await i.member.setNickname(nick);
            if(config?.roleNovato) await i.member.roles.remove(config.roleNovato).catch(()=>{});
            if(config?.roleVerificado1) await i.member.roles.add(config.roleVerificado1).catch(()=>{});
            if(config?.roleVerificado2) await i.member.roles.add(config.roleVerificado2).catch(()=>{});
            const roleName = `UID: ${id_ff}`;
            let r = i.guild.roles.cache.find(x => x.name === roleName);
            if(!r) r = await i.guild.roles.create({ name: roleName });
            await i.member.roles.add(r);
            await User.findOneAndUpdate({ discordId: i.user.id }, { ffNick: nick, ffId: id_ff, username: i.user.username }, { upsert: true });
            i.reply({ content: "✅ Registro concluído!", ephemeral: true });
        } catch (e) { i.reply({ content: "Erro: Verifique a hierarquia de cargos do bot.", ephemeral: true }); }
    }
});

// AVISO DE GUERRA
cron.schedule('0 16 * * 6', async () => {
    const c = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if(c?.canalAviso) {
        const chan = client.channels.cache.get(c.canalAviso);
        if(chan) chan.send(c.msgGuerra || "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!");
    }
}, { timezone: "America/Sao_Paulo" });

// --- DASHBOARD ---
const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'guild_secret', resave: false, saveUninitialized: false }));
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
    if(!guild) return res.send("Bot não está no servidor.");

    // Buscar membros no banco
    const dbUsers = await User.find();
    
    // Cruzar dados do Banco com dados do Discord
    const members = await Promise.all(dbUsers.map(async (u) => {
        const discordUser = await guild.members.fetch(u.discordId).catch(() => null);
        return {
            name: discordUser ? discordUser.user.tag : u.username,
            avatar: discordUser ? discordUser.user.displayAvatarURL() : 'https://cdn.discordapp.com/embed/avatars/0.png',
            ffNick: u.ffNick,
            ffId: u.ffId,
            lastMessage: u.lastMessage
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

app.listen(process.env.PORT || 3000, () => console.log("Servidor Online"));
client.login(process.env.TOKEN);
