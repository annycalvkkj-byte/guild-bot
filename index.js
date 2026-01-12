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

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

mongoose.connect(process.env.MONGO_URI);

const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String,
    lastSeen: { type: Date, default: Date.now },
    warnings: [{ reason: String, evidence: String, date: { type: Date, default: Date.now } }]
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String,
    roleMembro: String, roleCandidato: String,
    canalAviso: String, canalVerificacao: String, canalLogs: String, 
    canalRecrutamento: String, canalRegras: String, canalPunicao: String, msgGuerra: String
}));

// --- FUNÇÃO: SALVAR NA PLANILHA (DYNAMIC RANGE) ---
async function saveToSheet(range, data) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: range, // Ex: 'Respostas!A:J' ou 'Punições!A:F'
            valueInputOption: 'USER_ENTERED',
            resource: { values: [data] },
        });
    } catch (e) { console.error("ERRO PLANILHA:", e.message); }
}

async function getSheetData(range) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: range,
        });
        return res.data.values || [];
    } catch (e) { return []; }
}

// --- FUNÇÃO: CARGOS COLORIDOS ---
async function addColoredRole(guild, member, roleName) {
    if (!roleName) return;
    let color = "#99aab5";
    if (roleName.toLowerCase() === "masculino") color = "#3498db";
    if (roleName.toLowerCase() === "feminino") color = "#e91e63";

    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
        role = await guild.roles.create({ name: roleName, color: color, reason: 'Cargo Automático' }).catch(() => null);
    }
    if (role) await member.roles.add(role).catch(() => {});
}

// --- BOT EVENTS ---
client.on('interactionCreate', async (interaction) => {
    const config = await GuildConfig.findOne({ guildId: interaction.guild.id });
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const channel = await interaction.guild.channels.create({
            name: `recrut-${interaction.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
            ],
        });
        await channel.send({ content: `${interaction.user}`, embeds: [new EmbedBuilder().setTitle("🛡️ Pergunta 1").setDescription("Qual seu Nome Real?")] });
        
        const collector = channel.createMessageCollector({ filter: m => m.author.id === interaction.user.id, time: 600000 });
        let passo = 1; const resp = { discordId: interaction.user.id, tag: interaction.user.tag };
        
        collector.on('collect', async (m) => {
            if (passo === 1) { resp.nome = m.content; await m.reply("Nick no FF?"); }
            else if (passo === 2) { resp.nick = m.content; await m.reply("ID (UID)?"); }
            else if (passo === 3) { resp.id = m.content; await m.reply("Idade?"); }
            else if (passo === 4) {
                resp.idade = parseInt(m.content);
                if (resp.idade < 14) { await m.reply("Menor de 14 banido."); return interaction.member.ban({ reason: "Menor de 14" }); }
                await m.reply("Gênero (Masculino/Feminino)?");
            }
            else if (passo === 5) { resp.genero = m.content; await m.reply("Estado?"); }
            else if (passo === 6) { resp.estado = m.content; await m.reply("Mande a FOTO do perfil."); }
            else if (passo === 7) {
                resp.foto = m.attachments.first()?.url;
                if (!resp.foto) return m.reply("Mande a foto!");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('ja_ta_sim').setLabel('Sim, já estou').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('ja_ta_nao').setLabel('Não, quero entrar').setStyle(ButtonStyle.Danger)
                );
                await m.reply({ content: "Você já está na guilda?", components: [row] });
                await saveToSheet('Respostas!A:J', [resp.discordId, resp.tag, resp.nome, resp.nick, resp.id, resp.idade, resp.genero, resp.estado, resp.foto, "PENDENTE"]);
                collector.stop();
            }
            passo++;
        });
        await interaction.reply({ content: `Canal: ${channel}`, ephemeral: true });
    }

    if (interaction.isButton() && (interaction.customId === 'ja_ta_sim' || interaction.customId === 'ja_ta_nao')) {
        if (interaction.customId === 'ja_ta_sim') {
            await interaction.member.roles.add(config.roleMembro).catch(()=>{});
            await interaction.reply("Bem-vindo! Leia as regras.");
        } else {
            await interaction.member.roles.add(config.roleCandidato).catch(()=>{});
            const recrut = client.channels.cache.get(config.canalRecrutamento);
            if (recrut) {
                const msg = await recrut.send({ embeds: [new EmbedBuilder().setTitle("Novo Pedido").setDescription(`ID Discord: ${interaction.user.id}`).setColor("Yellow")] });
                await msg.react('✅');
            }
            await interaction.reply("Pedido enviado!");
        }
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || reaction.emoji.name !== '✅') return;
    const config = await GuildConfig.findOne({ guildId: reaction.message.guildId });
    const embed = reaction.message.embeds[0];
    const discordId = embed.description.split('ID Discord: ')[1];
    const member = await reaction.message.guild.members.fetch(discordId);
    const rows = await getSheetData('Respostas!A:J');
    const data = rows.find(r => r[0] === discordId);

    if (data && member) {
        const [id, tag, nome, nick, uid, idade, genero, estado, foto] = data;
        await member.setNickname(nick).catch(() => {});
        await member.roles.add(config.roleMembro);
        await member.roles.remove(config.roleCandidato).catch(() => {});
        await addColoredRole(reaction.message.guild, member, genero);
        await addColoredRole(reaction.message.guild, member, estado);
        await addDynamicRole(reaction.message.guild, member, `Idade: ${idade}`);
        await member.send("Aprovado!").catch(() => {});
        await reaction.message.delete();
    }
});

// --- SERVIDOR WEB ---
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
    const members = await User.find();
    res.render('dashboard', { members });
});

// --- PÁGINA DE PUNIÇÕES ---
app.get('/punishments', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const members = await User.find();
    const history = await getSheetData('Punições!A:G');
    res.render('punishments', { members, history });
});

app.post('/punish', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    const { discordId, type, reason, evidence, time } = req.body;
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const member = await guild.members.fetch(discordId).catch(() => null);
    const config = await GuildConfig.findOne({ guildId: guild.id });

    if (!member) return res.send("Membro não encontrado.");

    let actionText = "";
    try {
        if (type === "adv") {
            await User.findOneAndUpdate({ discordId }, { $push: { warnings: { reason, evidence } } });
            actionText = "Advertência Aplicada";
        } else if (type === "mute") {
            await member.timeout(parseInt(time) * 60 * 1000, reason);
            actionText = `Mute (${time} min)`;
        } else if (type === "kick") {
            await member.kick(reason);
            actionText = "Expulso";
        } else if (type === "ban") {
            await member.ban({ reason });
            actionText = "Banido Permanentemente";
        }

        // Salvar na Planilha
        await saveToSheet('Punições!A:G', [member.user.tag, discordId, actionText, reason, evidence, time || "N/A", req.user.username, new Date().toLocaleString()]);

        // Mandar no Canal de Punição
        const punChan = client.channels.cache.get(config.canalPunicao);
        if (punChan) {
            const embed = new EmbedBuilder()
                .setTitle("🚨 NOVA PUNIÇÃO APLICADA")
                .setColor("Red")
                .addFields(
                    { name: "👤 Nome:", value: `${member.user.tag}`, inline: true },
                    { name: "⚖️ Tipo:", value: actionText, inline: true },
                    { name: "📝 Motivo:", value: reason },
                    { name: "⏳ Tempo:", value: time ? `${time} minutos` : "Permanente", inline: true },
                    { name: "🔗 Evidência:", value: evidence || "Não fornecida" },
                    { name: "👮 Aplicado por:", value: `${req.user.username}` }
                )
                .setTimestamp();
            await punChan.send({ embeds: [embed] });
        }
        res.redirect('/punishments');
    } catch (e) {
        res.send("Erro ao aplicar punição: " + e.message);
    }
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
    const btn = new ButtonBuilder().setCustomId('btn_verificar').setLabel('Iniciar Recrutamento').setStyle(ButtonStyle.Primary);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("⚔️ RECRUTAMENTO").setColor("Blue")], components: [new ActionRowBuilder().addComponents(btn)] });
    res.redirect('/settings');
});

app.listen(process.env.PORT || 3000, () => console.log("Site ON"));
client.login(process.env.TOKEN);
