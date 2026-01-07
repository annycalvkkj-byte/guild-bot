require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const User = require('./models/User');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');

// --- CONFIGURAÇÃO DO BOT ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- CONEXÃO BANCO DE DADOS ---
mongoose.connect(process.env.MONGO_URI).then(() => console.log("MongoDB Conectado!"));

// --- LÓGICA DO BOT ---

// Aviso de Guerra (Sábado 16h)
cron.schedule('0 16 * * 6', async () => {
    const channel = client.channels.cache.get(process.env.CANAL_AVISO);
    if (channel) channel.send("@everyone ⚔️ **A GUERRA DE GUILDA COMEÇOU!** Todos para o jogo!");
}, { timezone: "America/Sao_Paulo" });

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    // Atualiza atividade do usuário
    await User.findOneAndUpdate({ discordId: message.author.id }, { lastMessage: new Date() });
    
    // Comando para criar botão de verificação (use apenas uma vez)
    if (message.content === '!setup-verificar' && message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const row = new ActionRowBuilder().addComponents(
            { type: 2, label: 'Verificar Guilda', style: 1, customId: 'btn_verificar' }
        );
        message.channel.send({ content: "Clique no botão para se verificar na guilda:", components: [row] });
    }
});

client.on('interactionCreate', async (interaction) => {
    // Abrir Modal
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Verificação Free Fire');
        const nickInput = new TextInputBuilder().setCustomId('nick').setLabel("Seu Nick no FF").setStyle(TextInputStyle.Short);
        const idInput = new TextInputBuilder().setCustomId('ffid').setLabel("Seu ID no FF").setStyle(TextInputStyle.Short);
        
        modal.addComponents(new ActionRowBuilder().addComponents(nickInput), new ActionRowBuilder().addComponents(idInput));
        await interaction.showModal(modal);
    }

    // Processar Modal
    if (interaction.isModalSubmit() && interaction.customId === 'modal_ff') {
        const nick = interaction.fields.getTextInputValue('nick');
        const ffid = interaction.fields.getTextInputValue('ffid');

        try {
            // 1. Mudar Nick
            await interaction.member.setNickname(nick);

            // 2. Dar cargos e remover antigo
            await interaction.member.roles.add([process.env.ROLE_VERIFICADO1, process.env.ROLE_VERIFICADO2]);
            await interaction.member.roles.remove(process.env.ROLE_NOVATO);

            // 3. Criar cargo de UID (CUIDADO: Limite de 250 cargos no Discord)
            const uidRole = await interaction.guild.roles.create({ name: `UID: ${ffid}`, reason: 'Verificação' });
            await interaction.member.roles.add(uidRole);

            // 4. Salvar no Banco
            await User.findOneAndUpdate(
                { discordId: interaction.user.id },
                { ffNick: nick, ffId: ffid, username: interaction.user.username },
                { upsert: true }
            );

            await interaction.reply({ content: "✅ Verificação concluída com sucesso!", ephemeral: true });
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: "❌ Erro ao processar cargos. Verifique se o Bot tem permissões.", ephemeral: true });
        }
    }
});

// --- CONFIGURAÇÃO DO SITE (EXPRESS) ---
const app = express();
app.set('view engine', 'ejs');

app.use(session({ secret: 'secret-key', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

app.get('/', (req, res) => res.send('<a href="/auth/discord">Login via Discord</a>'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const users = await User.find();
    res.render('dashboard', { users, user: req.user });
});

app.listen(process.env.PORT, () => console.log(`Site rodando na porta ${process.env.PORT}`));
client.login(process.env.TOKEN);
