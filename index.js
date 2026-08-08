require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const moment = require('moment'); 
const express = require('express');
const session = require('express-session');

// ==========================================
// INISIALISASI WEB SERVER
// ==========================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(session({ secret: 'brstore-secret-2026', resave: false, saveUninitialized: true }));

const WEBHOOK_PORT = process.env.PORT || 3000;

class JSONLock {
    constructor() { this.queue = Promise.resolve(); }
    async acquire() {
        let release;
        const next = new Promise(resolve => { release = resolve; });
        const current = this.queue;
        this.queue = current.then(() => next);
        await current;
        return release;
    }
}
const dbLock = new JSONLock();

const DB_DIR = path.join(__dirname, 'data');
const paths = {
    users: path.join(DB_DIR, 'users.json'),
    products: path.join(DB_DIR, 'products.json'),
    orders: path.join(DB_DIR, 'orders.json'),
    pending_qris: path.join(DB_DIR, 'pending_qris.json'), 
    admins: path.join(DB_DIR, 'admins.json'),
    config: path.join(DB_DIR, 'config.json'),
    stocks: path.join(DB_DIR, 'stocks')
};

async function readDB(filePath) { 
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return []; } 
}

async function readConfig() { 
    try { return JSON.parse(await fs.readFile(paths.config, 'utf8')); } 
    catch { return { storeName: "BR STORE", token: "", adminId: "", qrisString: "", trxPrefix: "BR", autoPayUrl: "", autoPaySecret: "" }; } 
}

// ==========================================
// FUNGSI API AUTO PAY KE SERVER B
// ==========================================
async function runAutoPayQuietly(accounts) {
    const config = await readConfig();
    const REMOTE_SERVER_URL = config.autoPayUrl; 
    const API_SECRET = config.autoPaySecret; 

    if (!REMOTE_SERVER_URL) {
        console.log("⚠️ [SYSTEM] URL Auto Pay belum diatur di Panel Admin. Melewati proses Auto Pay.");
        return;
    }

    try {
        console.log(`🚀 [SYSTEM] Mengirim ${accounts.length} akun ke Server Auto Pay...`);
        fetch(REMOTE_SERVER_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': API_SECRET 
            },
            body: JSON.stringify({ accounts: accounts })
        })
        .then(res => res.json())
        .then(data => {
            if(data.success) {
                console.log("✅ [SYSTEM] Server Auto Pay merespons: Data diterima.");
            } else {
                console.error("❌ [SYSTEM] Server Auto Pay menolak:", data.error);
            }
        })
        .catch(err => {
            console.error("❌ [SYSTEM] Gagal terhubung ke Server Auto Pay:", err.message);
        });
    } catch (error) {
        console.error("❌ [SYSTEM] Error internal saat mengirim:", error.message);
    }
}

// ==========================================
// SISTEM AUTO-CLEANUP QRIS EXPIRED (5 MENIT)
// ==========================================
async function cleanupExpiredQris() {
    const release = await dbLock.acquire();
    try {
        let pQris = await readDB(paths.pending_qris);
        if (pQris.length === 0) return; 

        const now = Date.now();
        const EXPIRE_TIME = 5 * 60 * 1000; 

        let activeQris = [];
        let isModified = false;

        for (let order of pQris) {
            if (!order.timestamp || (now - order.timestamp > EXPIRE_TIME)) {
                try {
                    const sp = path.join(paths.stocks, `stock_${order.var_id}.json`);
                    let sd = await readDB(sp);
                    sd.push(...order.reserved_accounts);
                    await fs.writeFile(sp, JSON.stringify(sd, null, 2));
                    
                    if (bot && order.user_id) {
                        bot.sendMessage(order.user_id, `⚠️ *Batal Otomatis*\n\nPesanan \`${order.order_id}\` dibatalkan (Melebihi batas waktu 5 menit atau sistem di-restart). Stok telah dikembalikan ke etalase.`, { parse_mode: 'Markdown' }).catch(()=>{});
                        
                        // [FITUR BARU] Hapus pesan QRIS saat order kedaluwarsa
                        if (order.msg_id) {
                            bot.deleteMessage(order.user_id, order.msg_id).catch(()=>{});
                        }
                    }
                } catch (e) { }
                isModified = true;
            } else {
                activeQris.push(order);
            }
        }

        if (isModified) {
            await fs.writeFile(paths.pending_qris, JSON.stringify(activeQris, null, 2));
            console.log("🧹 [SYSTEM] Cleanup QRIS selesai. Stok yang menggantung telah dikembalikan.");
        }
    } finally {
        release();
    }
}

async function initDB() {
    await fs.mkdir(DB_DIR, { recursive: true }); 
    await fs.mkdir(paths.stocks, { recursive: true });
    
    const defaultAdmins = [{ username: 'owner', password: 'ownerpassword', role: 'owner' }];
    try { await fs.access(paths.admins); } catch { await fs.writeFile(paths.admins, JSON.stringify(defaultAdmins, null, 2)); }
    try { await fs.access(paths.config); } catch { await fs.writeFile(paths.config, JSON.stringify({ storeName: "BR STORE", token: "", adminId: "", qrisString: "", trxPrefix: "BR", autoPayUrl: "", autoPaySecret: "" }, null, 2)); }
    
    const defaultFiles = [paths.users, paths.products, paths.orders, paths.pending_qris];
    for (const file of defaultFiles) { 
        try { await fs.access(file); } catch { await fs.writeFile(file, '[]', 'utf8'); } 
    }
    setupTelegramBot(); 

    await cleanupExpiredQris(); 
    setInterval(cleanupExpiredQris, 60 * 1000); 
}

// ==========================================
// SISTEM TELEGRAM BOT
// ==========================================
let bot = null;

function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) > 0) crc = (crc << 1) ^ 0x1021;
            else crc = crc << 1;
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function makeDynamicQris(qris, amount) {
    try {
        let qrisTanpaCrc = qris.substring(0, qris.lastIndexOf('6304'));
        qrisTanpaCrc = qrisTanpaCrc.replace('010211', '010212');
        let strAmount = amount.toString(); 
        let tagAmount = "54" + strAmount.length.toString().padStart(2, '0') + strAmount;
        
        if (qrisTanpaCrc.includes('5802ID')) { 
            qrisTanpaCrc = qrisTanpaCrc.replace('5802ID', tagAmount + '5802ID'); 
        } else { 
            qrisTanpaCrc += tagAmount; 
        }
        
        let newQris = qrisTanpaCrc + "6304"; 
        return newQris + crc16(newQris);
    } catch (e) { 
        return qris; 
    }
}

function calculatePrice(selVar, qty) {
    let baseVPrice = selVar.price || 0;
    let finalPrice = baseVPrice;
    let isGrosir = false;

    if (selVar.wholesaleMinQty && selVar.wholesalePrice && qty >= selVar.wholesaleMinQty) {
        finalPrice = selVar.wholesalePrice;
        isGrosir = true;
    }

    let total = finalPrice * qty;
    return { total: Math.round(total), baseVPrice: Math.round(baseVPrice), finalPrice: Math.round(finalPrice), isGrosir };
}

async function setupTelegramBot() {
    const config = await readConfig();
    if (bot) { 
        try { await bot.stopPolling(); } catch (e) {} 
        bot = null; 
    }
    if (!config.token) return console.log("⚠️ [BOT] Token Telegram belum diset!");
    
    bot = new TelegramBot(config.token, { polling: true });
    console.log("✅ [BOT] Telegram Bot Berhasil Berjalan!");
    bot.on('polling_error', () => {}); 

    function chunkArray(array, size) { 
        const chunked = []; 
        for (let i = 0; i < array.length; i += size) chunked.push(array.slice(i, i + size)); 
        return chunked; 
    }

    async function getStockCount(varId) { 
        try { 
            const d = await readDB(path.join(paths.stocks, `stock_${varId}.json`)); 
            return Array.isArray(d) ? d.length : 0; 
        } catch { 
            return 0; 
        } 
    }

    function renderVarMenu(product) {
        let descText = (product.description && product.description.trim() !== '') ? `_${product.description}_\n\n` : '';
        let text = `🛒 *${product.name}*\n${descText}*Pilihan Paket:*\n`;
        let btns = [];
        
        product.variations.forEach(v => {
            text += `• ${v.name} : Rp ${v.price.toLocaleString('id-ID')}\n`;
            if (v.wholesaleMinQty && v.wholesalePrice) {
                text += `  └ _(Beli min. ${v.wholesaleMinQty} otomatis jadi Rp ${v.wholesalePrice.toLocaleString('id-ID')}/item)_\n`;
            }
            btns.push({ text: v.name, callback_data: `sel|${v.id}` });
        });
        
        let layout = chunkArray(btns, 2); 
        layout.push([{ text: '⬅️ Kembali', callback_data: `back_main` }]);
        return { text, reply_markup: { inline_keyboard: layout } };
    }

    function renderOrder(product, v, qty, stock) {
        let calc = calculatePrice(v, qty);
        
        let text = `🛒 *Ringkasan Pesanan*\n\nProduk: ${product.name}\nVarian: ${v.name}\n\n`;
        text += `Harga: Rp ${calc.baseVPrice.toLocaleString('id-ID')}\n`;
        text += `Stok: ${stock}\nJumlah: x${qty}\n`;
        text += `\n*Total Pembayaran: Rp ${calc.total.toLocaleString('id-ID')}*`;
        
        return {
            text, 
            reply_markup: { inline_keyboard: [
                [{ text: '-1', callback_data: `qty|-1|${v.id}|${qty}` }, { text: '+1', callback_data: `qty|+1|${v.id}|${qty}` }],
                [{ text: '💳 Saldo', callback_data: `pay|saldo|${v.id}|${qty}` }, { text: '📱 QRIS', callback_data: `pay|qris|${v.id}|${qty}` }],
                [{ text: '⬅️ Kembali', callback_data: `back_var|${product.slug}` }]
            ]}
        };
    }

    bot.onText(/\/start|🏠 Menu/, async (msg) => {
        const release = await dbLock.acquire(); 
        try {
            let users = await readDB(paths.users); 
            let user = users.find(u => u.id === msg.from.id);
            if (!user) { 
                user = { id: msg.from.id, username: msg.from.username, first_name: msg.from.first_name, balance: 0, trx_count: 0, joined_at: moment().format('YYYY-MM-DD HH:mm:ss') }; 
                users.push(user); 
                await fs.writeFile(paths.users, JSON.stringify(users, null, 2)); 
            }
            
            let products = await readDB(paths.products);
            if (!products.length) return bot.sendMessage(msg.chat.id, `Halo! Belum ada produk.`);

            let txt = `Halo ${user.first_name} | **${config.storeName}** 🚀\n\n📦 *Product List*\n\n`;
            let btns = [];
            products.forEach((p, i) => { 
                txt += `${i + 1}. ${p.name}\n`; 
                btns.push({ text: (i + 1).toString() }); 
            });
            
            let layout = chunkArray(btns, 5); 
            layout.unshift([{ text: '🏷️ List Produk' }, { text: `💰 Saldo: Rp${(user.balance || 0).toLocaleString('id-ID')}` }]); 
            bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown', reply_markup: { keyboard: layout, resize_keyboard: true } });
        } finally { release(); }
    });

    bot.on('message', async (msg) => {
        if (msg.text === '🏷️ List Produk') {
            bot.sendMessage(msg.chat.id, "Ketik /start lalu pilih angka.");
        } else if (msg.text && msg.text.startsWith('💰 Saldo:')) {
            let users = await readDB(paths.users); 
            let user = users.find(u => u.id === msg.from.id) || { balance: 0 };
            bot.sendMessage(msg.chat.id, `Saldo: **Rp${(user.balance || 0).toLocaleString('id-ID')}**`, { parse_mode: 'Markdown' }); 
        }
    });

    bot.onText(/^(\d+)$/, async (msg, match) => {
        let products = await readDB(paths.products);
        let num = parseInt(match[1]);
        if (num > 0 && num <= products.length) {
            const { text, reply_markup } = renderVarMenu(products[num - 1]);
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup });
        }
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id; 
        const msgId = query.message.message_id;
        const parts = query.data.split('|'); 
        const action = parts[0]; 

        if (action === 'back_main') { 
            bot.deleteMessage(chatId, msgId).catch(()=>{}); 
            return bot.answerCallbackQuery(query.id); 
        }

        let products = await readDB(paths.products);
        if (action === 'back_var') {
            const prod = products.find(p => p.slug === parts[1]);
            if (prod) { 
                const { text, reply_markup } = renderVarMenu(prod); 
                bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup }).catch(()=>{}); 
            }
            return bot.answerCallbackQuery(query.id);
        }

        if (action === 'batal_qris') {
            bot.answerCallbackQuery(query.id, { text: "Dibatalkan." }); 
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            const release = await dbLock.acquire();
            try {
                let pQris = await readDB(paths.pending_qris); 
                const idx = pQris.findIndex(o => o.order_id === parts[1]);
                if (idx !== -1) {
                    const sp = path.join(paths.stocks, `stock_${pQris[idx].var_id}.json`); 
                    let sd = await readDB(sp);
                    sd.push(...pQris[idx].reserved_accounts); 
                    await fs.writeFile(sp, JSON.stringify(sd, null, 2));
                    pQris.splice(idx, 1); 
                    await fs.writeFile(paths.pending_qris, JSON.stringify(pQris, null, 2));
                }
            } finally { release(); }
            return;
        }

        let selProd = null, selVar = null;
        let vId = (action === 'qty' || action === 'pay') ? parts[2] : null; 
        if(action === 'sel') vId = parts[1];
        
        for (const p of products) { 
            if (p.variations) { 
                const f = p.variations.find(v => v.id === vId); 
                if (f) { selProd = p; selVar = f; break; } 
            } 
        }
        
        if (!selVar) return bot.answerCallbackQuery(query.id, { text: "Error: Variasi tidak ditemukan" });
        const stockCount = await getStockCount(selVar.id);

        if (action === 'sel' || action === 'qty') {
            let qty = action === 'sel' ? 1 : parseInt(parts[3]);
            if (action === 'qty') { 
                const op = parts[1]; 
                if (op === '+1') qty += 1; 
                if (op === '-1') qty -= 1; 
            }
            if (qty < 1) qty = 1; 
            if (qty > stockCount) { 
                qty = stockCount; 
                bot.answerCallbackQuery(query.id, { text: "Stok maksimal!" }); 
            } else { 
                bot.answerCallbackQuery(query.id); 
            }
            
            const { text, reply_markup } = renderOrder(selProd, selVar, qty, stockCount);
            bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup }).catch(()=>{});
        } 
        else if (action === 'pay') {
            const finalQty = parseInt(parts[3]);
            const calcData = calculatePrice(selVar, finalQty);
            const basePrice = calcData.total;
            
            if (finalQty > stockCount || stockCount === 0) return bot.answerCallbackQuery(query.id, { text: "❌ Stok habis.", show_alert: true });
            
            if (parts[1] === 'saldo') {
                const cfg = await readConfig(); 
                const prefix = cfg.trxPrefix || "BR"; 
                const release = await dbLock.acquire(); 
                try {
                    let users = await readDB(paths.users); 
                    let userIndex = users.findIndex(u => u.id === query.from.id); 
                    let user = users[userIndex];
                    
                    if ((user.balance || 0) < basePrice) {
                        bot.answerCallbackQuery(query.id, { text: "❌ Saldo tidak mencukupi.", show_alert: true });
                        return bot.sendMessage(chatId, `❌ Saldo tidak mencukupi.`);
                    }
                    
                    bot.answerCallbackQuery(query.id);
                    const sp = path.join(paths.stocks, `stock_${selVar.id}.json`); 
                    let sd = await readDB(sp);
                    user.balance -= basePrice; 
                    user.trx_count = (user.trx_count || 0) + basePrice; 
                    await fs.writeFile(paths.users, JSON.stringify(users, null, 2));
                    
                    const accs = sd.splice(0, finalQty); 
                    await fs.writeFile(sp, JSON.stringify(sd, null, 2));
                    
                    let orders = await readDB(paths.orders); 
                    let oid = `${prefix}-${Date.now()}`;
                    
                    orders.push({ order_id: oid, user_id: user.id, product: `${selProd.name} - ${selVar.name}`, qty: finalQty, total: basePrice, date: moment().format('YYYY-MM-DD HH:mm'), paymentMethod: 'balance', accounts: accs });
                    await fs.writeFile(paths.orders, JSON.stringify(orders, null, 2));
                    
                    let noteText = selProd.name.toLowerCase().includes('youtube') ? `\n\n⚠️ *CATATAN PENTING:*\nJangan mengubah password atau login ke akun selama **10-15 menit** ke depan. Sistem kami sedang memproses aktivasi Premium otomatis di belakang layar.` : '';
                    bot.sendMessage(chatId, `✅ **LUNAS** ✅\nInvoice: \`${oid}\`\n\n📦 **AKUN:**\n${accs.join('\n')}${noteText}`, { parse_mode: 'Markdown' });

                    if (selProd.name.toLowerCase().includes('youtube')) runAutoPayQuietly(accs);

                } finally { release(); }
            } else if (parts[1] === 'qris') {
                const cfg = await readConfig(); 
                const prefix = cfg.trxPrefix || "BR"; 
                if (!cfg.qrisString) {
                    bot.answerCallbackQuery(query.id, { text: "⚠️ QRIS belum diatur Admin.", show_alert: true }); 
                    return bot.sendMessage(chatId, "⚠️ QRIS belum diatur Admin.");
                }
                
                const release = await dbLock.acquire();
                try {
                    const sp = path.join(paths.stocks, `stock_${selVar.id}.json`); 
                    let sd = await readDB(sp);
                    const resAccs = sd.splice(0, finalQty); 
                    await fs.writeFile(sp, JSON.stringify(sd, null, 2));
                    
                    const kodeUnik = Math.floor(Math.random() * 20) + 1; 
                    const finalTotal = basePrice + kodeUnik; 
                    const oid = `${prefix}-${Date.now()}`;
                    const dynamicQrisString = makeDynamicQris(cfg.qrisString, finalTotal);
                    
                    // [FITUR BARU] Siapkan object pesanan terlebih dahulu tanpa disave
                    let newPendingOrder = { 
                        order_id: oid, 
                        user_id: query.from.id, 
                        var_id: selVar.id, 
                        qty: finalQty, 
                        total: finalTotal, 
                        reserved_accounts: resAccs, 
                        status: 'pending', 
                        date: moment().format('YYYY-MM-DD HH:mm:ss'),
                        timestamp: Date.now() 
                    };
                    
                    const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(dynamicQrisString)}&size=400&margin=2`;
                    const cap = `*PESAN TERKONFIRMASI*\n\nInvoice: \`${oid}\`\nProduk: ${selProd.name}\nVariasi: ${selVar.name}\n*Total: Rp ${finalTotal.toLocaleString('id-ID')}*\n\n⏳ _Segera lakukan pembayaran, pesanan akan dibatalkan otomatis dalam 5 menit._`;
                    
                    bot.answerCallbackQuery(query.id); 
                    bot.deleteMessage(chatId, msgId).catch(()=>{});
                    
                    // [FITUR BARU] Kirim pesan QRIS lalu tangkap message_id nya
                    const sentMsg = await bot.sendPhoto(chatId, qrUrl, { caption: cap, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Batalkan', callback_data: `batal_qris|${oid}` }]] } });
                    
                    // [FITUR BARU] Masukkan message_id ke dalam object, lalu simpan ke database
                    newPendingOrder.msg_id = sentMsg.message_id;
                    let pq = await readDB(paths.pending_qris);
                    pq.push(newPendingOrder);
                    await fs.writeFile(paths.pending_qris, JSON.stringify(pq, null, 2));

                } finally { release(); }
            }
        }
    });
}

// ==========================================
// ENDPOINT API & DASHBOARD
// ==========================================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/owner', (req, res) => { res.redirect('/admin'); });

app.post('/api/auth/login', async (req, res) => {
    const admins = await readDB(paths.admins); 
    const user = admins.find(u => u.username === req.body.username && u.password === req.body.password);
    if (user) { 
        req.session.user = { username: user.username, role: user.role }; 
        return res.json({ success: true, user: req.session.user }); 
    }
    res.status(401).json({ success: false, error: 'Login gagal! Username atau password salah.' });
});

app.get('/api/auth/me', (req, res) => { 
    res.json(req.session.user ? { user: req.session.user } : { error: 'Not Logged In' }); 
});

app.post('/api/auth/logout', (req, res) => { 
    req.session.destroy(); 
    res.json({ success: true }); 
});

app.post('/api/auth/change-profile', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const release = await dbLock.acquire();
    try {
        let admins = await readDB(paths.admins); 
        const idx = admins.findIndex(u => u.username === req.session.user.username);
        
        if (idx === -1) return res.status(404).json({ error: 'User tidak ditemukan' });
        if (admins[idx].password !== req.body.currentPassword) return res.status(400).json({ error: 'Password saat ini salah!' });
        
        if (req.body.username) { admins[idx].username = req.body.username; req.session.user.username = req.body.username; }
        if (req.body.password) { admins[idx].password = req.body.password; }
        
        await fs.writeFile(paths.admins, JSON.stringify(admins, null, 2)); 
        res.json({ success: true });
    } finally { release(); }
});

app.get('/api/bots', async (req, res) => { 
    const config = await readConfig(); 
    res.json([{ botId: 'brstore_store', NAMA_TOKO: config.storeName || "BR STORE", isRunning: bot !== null }]); 
});

app.get('/api/bot/stats', async (req, res) => {
    const config = await readConfig(); 
    const users = await readDB(paths.users); 
    const orders = await readDB(paths.orders); 
    const products = await readDB(paths.products);
    
    let totalRev = orders.reduce((s, o) => s + o.total, 0); 
    let totalStock = 0;
    
    try { 
        const stockFiles = await fs.readdir(paths.stocks); 
        for (const file of stockFiles) { 
            if (file.endsWith('.json')) { 
                const stockData = await readDB(path.join(paths.stocks, file)); 
                if (Array.isArray(stockData)) totalStock += stockData.length; 
            } 
        } 
    } catch (e) { }
    
    res.json({ 
        isRunning: bot !== null, 
        storeName: config.storeName, 
        totalUsers: users.length, 
        totalProducts: products.length, 
        totalOrders: orders.length, 
        revenue: totalRev, 
        totalStock: totalStock 
    });
});

app.get('/api/bot/config', async (req, res) => res.json(await readConfig()));

app.post('/api/bot/config', async (req, res) => {
    let cfg = await readConfig(); 
    cfg = { ...cfg, ...req.body }; 
    await fs.writeFile(paths.config, JSON.stringify(cfg, null, 2));
    if (req.body.token !== undefined) setupTelegramBot(); 
    res.json({ success: true });
});

app.get('/api/bot/products', async (req, res) => res.json(await readDB(paths.products)));

app.post('/api/bot/products', async (req, res) => {
    let p = await readDB(paths.products); 
    p.push({ ...req.body, variations: [] });
    await fs.writeFile(paths.products, JSON.stringify(p, null, 2)); 
    res.json({ success: true });
});

app.put('/api/bot/products/:slug', async (req, res) => {
    let p = await readDB(paths.products); 
    const idx = p.findIndex(x => x.slug === req.params.slug);
    if(idx !== -1) {
        if(req.body.name !== undefined) p[idx].name = req.body.name;
        if(req.body.description !== undefined) p[idx].description = req.body.description;
        await fs.writeFile(paths.products, JSON.stringify(p, null, 2));
    }
    res.json({ success: true });
});

app.delete('/api/bot/products/:slug', async (req, res) => {
    let p = await readDB(paths.products); 
    p = p.filter(x => x.slug !== req.params.slug);
    await fs.writeFile(paths.products, JSON.stringify(p, null, 2)); 
    res.json({ success: true });
});

// API Variasi & Diskon Grosir
app.post('/api/bot/products/:slug/variations', async (req, res) => {
    let p = await readDB(paths.products); 
    const f = p.find(x => x.slug === req.params.slug);
    if(f) { 
        f.variations.push({ id: `var_${Date.now()}`, ...req.body, price: parseInt(req.body.price), wholesaleMinQty: null, wholesalePrice: null }); 
        await fs.writeFile(paths.products, JSON.stringify(p, null, 2)); 
    }
    res.json({ success: true });
});

app.put('/api/bot/products/:slug/variations/:varId', async (req, res) => {
    let p = await readDB(paths.products); 
    const f = p.find(x => x.slug === req.params.slug);
    if(f) {
        const v = f.variations.find(x => x.id === req.params.varId);
        if(v) {
            if(req.body.name !== undefined) v.name = req.body.name;
            if(req.body.price !== undefined) v.price = parseInt(req.body.price);
            
            if(req.body.wholesale !== undefined) {
                if (req.body.wholesale === null) {
                    v.wholesaleMinQty = null;
                    v.wholesalePrice = null;
                } else {
                    v.wholesaleMinQty = parseInt(req.body.wholesale.minQty);
                    v.wholesalePrice = parseInt(req.body.wholesale.price);
                }
            }
            
            await fs.writeFile(paths.products, JSON.stringify(p, null, 2));
        }
    }
    res.json({ success: true });
});

app.delete('/api/bot/products/:slug/variations/:varId', async (req, res) => {
    let p = await readDB(paths.products); 
    const f = p.find(x => x.slug === req.params.slug);
    if(f) { 
        f.variations = f.variations.filter(v => v.id !== req.params.varId); 
        await fs.writeFile(paths.products, JSON.stringify(p, null, 2)); 
    }
    res.json({ success: true });
});

app.get('/api/bot/stock/:id', async (req, res) => { 
    let d = await readDB(path.join(paths.stocks, `stock_${req.params.id}.json`)); 
    res.json({ count: d.length || 0, codes: d || [] }); 
});

app.post('/api/bot/stock/:id', async (req, res) => { 
    const p = path.join(paths.stocks, `stock_${req.params.id}.json`); 
    let d = await readDB(p); 
    d.push(...req.body.codes.split('\n').filter(c=>c.trim())); 
    await fs.writeFile(p, JSON.stringify(d, null, 2)); 
    res.json({ success: true }); 
});

app.get('/api/bot/users', async (req, res) => { 
    const users = await readDB(paths.users); 
    res.json(users.map(u => ({ userId: u.id, username: u.username, firstName: u.first_name, firstSeen: u.joined_at, balance: u.balance || 0 }))); 
});

app.post('/api/bot/balance/:id/add', async (req, res) => { 
    let u = await readDB(paths.users); 
    const i = u.findIndex(x => x.id === parseInt(req.params.id)); 
    if(i > -1) { 
        u[i].balance = (u[i].balance || 0) + parseInt(req.body.amount); 
        await fs.writeFile(paths.users, JSON.stringify(u, null, 2)); 
    } 
    res.json({ success: true }); 
});

// ==========================================
// PENDING QRIS & APPROVAL MANUAL
// ==========================================
app.get('/api/bot/pending', async (req, res) => {
    res.json(await readDB(paths.pending_qris));
});

app.post('/api/bot/pending/:id/approve', async (req, res) => {
    const release = await dbLock.acquire();
    try {
        let pq = await readDB(paths.pending_qris);
        const idx = pq.findIndex(o => o.order_id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Pesanan tidak ditemukan atau sudah expired' });
        
        const orderData = pq[idx];
        
        let p = await readDB(paths.products); 
        let selProd = { name: "Unknown" }, selVar = { name: "Unknown" };
        for (const pr of p) { 
            if (pr.variations) { 
                const f = pr.variations.find(v => v.id === orderData.var_id); 
                if (f) { selProd = pr; selVar = f; break; } 
            } 
        }
        
        let orders = await readDB(paths.orders);
        orders.push({ 
            order_id: orderData.order_id, 
            user_id: orderData.user_id, 
            product: `${selProd.name} - ${selVar.name}`, 
            qty: orderData.qty, 
            total: orderData.total, 
            date: moment().format('YYYY-MM-DD HH:mm'), 
            paymentMethod: 'qris_manual',
            accounts: orderData.reserved_accounts 
        });
        await fs.writeFile(paths.orders, JSON.stringify(orders, null, 2));
        
        let noteText = selProd.name.toLowerCase().includes('youtube') ? `\n\n⚠️ *CATATAN PENTING:*\nJangan mengubah password atau login ke akun selama **10-15 menit** ke depan. Sistem kami sedang memproses aktivasi Premium otomatis di belakang layar.` : '';
        if (bot) bot.sendMessage(orderData.user_id, `🎉 **PEMBAYARAN DISETUJUI MANUAL!**\n\nInvoice: \`${orderData.order_id}\`\n\n📦 **AKUN:**\n${orderData.reserved_accounts.join('\n')}${noteText}`, { parse_mode: 'Markdown' });
        
        // [FITUR BARU] Hapus pesan QRIS setelah disetujui admin
        if (bot && orderData.msg_id) bot.deleteMessage(orderData.user_id, orderData.msg_id).catch(()=>{});

        pq.splice(idx, 1); 
        await fs.writeFile(paths.pending_qris, JSON.stringify(pq, null, 2));
        res.json({ success: true });

        if (selProd.name.toLowerCase().includes('youtube')) runAutoPayQuietly(orderData.reserved_accounts);

    } finally { release(); }
});

app.post('/api/bot/pending/:id/reject', async (req, res) => {
    const release = await dbLock.acquire();
    try {
        let pq = await readDB(paths.pending_qris);
        const idx = pq.findIndex(o => o.order_id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Not found' });
        
        const orderData = pq[idx];
        const sp = path.join(paths.stocks, `stock_${orderData.var_id}.json`); 
        let sd = await readDB(sp);
        sd.push(...orderData.reserved_accounts); 
        await fs.writeFile(sp, JSON.stringify(sd, null, 2));
        
        if (bot) bot.sendMessage(orderData.user_id, `❌ **PEMBAYARAN DITOLAK**\n\nInvoice: \`${orderData.order_id}\`\nPesanan dibatalkan oleh admin dan stok telah dikembalikan.`, { parse_mode: 'Markdown' });
        
        // [FITUR BARU] Hapus pesan QRIS setelah ditolak admin
        if (bot && orderData.msg_id) bot.deleteMessage(orderData.user_id, orderData.msg_id).catch(()=>{});

        pq.splice(idx, 1); 
        await fs.writeFile(paths.pending_qris, JSON.stringify(pq, null, 2));
        res.json({ success: true });
    } finally { release(); }
});

app.get('/api/bot/transactions', async (req, res) => { 
    const orders = await readDB(paths.orders);
    res.json(orders.map(o => ({ 
        trxId: o.order_id, 
        userId: o.user_id, 
        product: o.product, 
        paymentMethod: o.paymentMethod || 'balance', 
        amount: o.total, 
        purchaseDate: o.date, 
        accounts: o.accounts || [] 
    }))); 
});

// WEBHOOK DANA
app.post('/dana-webhook', async (req, res) => {
    const text = req.body.message || req.body.text || JSON.stringify(req.body);
    const match = text.match(/Rp\s*([\d\.]+)/i); 
    if (!match) return res.send("Abaikan");
    
    const amount = parseInt(match[1].replace(/\./g, ''));
    let pq = await readDB(paths.pending_qris); 
    const idx = pq.findIndex(o => o.total === amount);
    
    if (idx !== -1) {
        const orderData = pq[idx]; 
        let p = await readDB(paths.products); 
        let selProd = { name: "Unknown" }, selVar = { name: "Unknown" };
        for (const pr of p) { 
            if (pr.variations) { 
                const f = pr.variations.find(v => v.id === orderData.var_id); 
                if (f) { selProd = pr; selVar = f; break; } 
            } 
        }
        
        let orders = await readDB(paths.orders);
        orders.push({ order_id: orderData.order_id, user_id: orderData.user_id, product: `${selProd.name} - ${selVar.name}`, qty: orderData.qty, total: orderData.total, date: moment().format('YYYY-MM-DD HH:mm'), paymentMethod: 'qris', accounts: orderData.reserved_accounts });
        await fs.writeFile(paths.orders, JSON.stringify(orders, null, 2));
        
        let noteText = selProd.name.toLowerCase().includes('youtube') ? `\n\n⚠️ *CATATAN PENTING:*\nJangan mengubah password atau login ke akun selama **10-15 menit** ke depan. Sistem kami sedang memproses aktivasi Premium otomatis di belakang layar.` : '';
        if (bot) bot.sendMessage(orderData.user_id, `🎉 **PEMBAYARAN DANA TERDETEKSI!**\n\nInvoice: \`${orderData.order_id}\`\n\n📦 **AKUN:**\n${orderData.reserved_accounts.join('\n')}${noteText}`, { parse_mode: 'Markdown' });
        
        // [FITUR BARU] Hapus pesan QRIS otomatis setelah webhook DANA sukses
        if (bot && orderData.msg_id) bot.deleteMessage(orderData.user_id, orderData.msg_id).catch(()=>{});

        pq.splice(idx, 1); 
        await fs.writeFile(paths.pending_qris, JSON.stringify(pq, null, 2));

        if (selProd.name.toLowerCase().includes('youtube')) runAutoPayQuietly(orderData.reserved_accounts);

        return res.send("Sukses");
    }
    res.send("Not Found");
});

app.listen(WEBHOOK_PORT, () => { 
    console.log(`🌐 Web Dashboard & Server Webhook aktif di: http://localhost:${WEBHOOK_PORT}`); 
    initDB(); 
});