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
// FUNGSI AUTO BACKUP DATABASE KE TELEGRAM
// ==========================================
async function sendDatabaseBackup(targetChatId = null) {
    try {
        const config = await readConfig();
        const adminId = targetChatId || config.adminId;
        
        if (!adminId || !bot) {
            console.log("⚠️ [BACKUP] Admin ID belum diset atau Bot belum aktif. Gagal mengirim backup.");
            return;
        }

        let filesToBackup = [];
        try {
            const rootFiles = ['users.json', 'products.json', 'orders.json', 'pending_qris.json', 'admins.json', 'config.json'];
            for (let f of rootFiles) {
                let p = path.join(DB_DIR, f);
                try {
                    await fs.access(p);
                    filesToBackup.push(p);
                } catch {}
            }

            try {
                const stockFiles = await fs.readdir(paths.stocks);
                for (let sf of stockFiles) {
                    if (sf.endsWith('.json')) {
                        filesToBackup.push(path.join(paths.stocks, sf));
                    }
                }
            } catch {}

            if (filesToBackup.length === 0) {
                if (targetChatId) bot.sendMessage(targetChatId, "⚠️ Tidak ada file database yang ditemukan untuk di-backup.");
                return;
            }

            await bot.sendMessage(adminId, `📦 *AUTO BACKUP DATABASE*\n🗓️ Waktu: ${moment().format('YYYY-MM-DD HH:mm:ss')}\n📁 Total File: ${filesToBackup.length} file`, { parse_mode: 'Markdown' });

            for (let filePath of filesToBackup) {
                let fileName = path.basename(filePath);
                if (filePath.includes('stocks')) {
                    fileName = `stock_${fileName}`;
                }
                await bot.sendDocument(adminId, filePath, {}, {
                    filename: fileName,
                    contentType: 'application/json'
                });
            }

            console.log("✅ [BACKUP] Berhasil mengirim database backup ke Telegram Admin.");
            if (targetChatId) {
                bot.sendMessage(targetChatId, "✅ Backup database berhasil dikirim ke chat ini!");
            }
        } catch (err) {
            console.error("❌ [BACKUP] Gagal membaca direktori database:", err.message);
        }
    } catch (e) {
        console.error("❌ [BACKUP ERROR]:", e.message);
    }
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
                        bot.sendMessage(order.user_id, `⚠️ *BATAL OTOMATIS*\n\nPesanan \`${order.order_id}\` telah dibatalkan karena melebihi batas waktu 5 menit.\n\n_👇 Klik tombol di bawah untuk kembali berbelanja:_`, { 
                            parse_mode: 'Markdown',
                            reply_markup: {
                                keyboard: [[{ text: '🏷️ Daftar Produk' }, { text: '💰 Cek Saldo' }]],
                                resize_keyboard: true
                            }
                        }).catch(()=>{});
                        
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

    // Jadwal Auto Backup setiap 24 jam sekali
    setInterval(() => {
        sendDatabaseBackup();
    }, 24 * 60 * 60 * 1000);
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

    // --- FUNGSI REUSABLE UNTUK MENU UTAMA (SESUAI GAMBAR REFERENSI)[cite: 4] ---
    async function sendMainMenu(chatId, fromUser, page = 1, editMsgId = null) {
        const release = await dbLock.acquire(); 
        try {
            let users = await readDB(paths.users); 
            let user = users.find(u => u.id === fromUser.id);
            if (!user) { 
                user = { id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name, balance: 0, trx_count: 0, joined_at: moment().format('YYYY-MM-DD HH:mm:ss') }; 
                users.push(user); 
                await fs.writeFile(paths.users, JSON.stringify(users, null, 2)); 
            }
            
            let products = await readDB(paths.products);
            if (!products.length) {
                const noProdTxt = `Halo! Belum ada produk saat ini.`;
                if (editMsgId) return bot.editMessageText(noProdTxt, {chat_id: chatId, message_id: editMsgId}).catch(()=>{});
                return bot.sendMessage(chatId, noProdTxt);
            }

            const ITEMS_PER_PAGE = 9;
            const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE) || 1;
            if (page < 1) page = 1;
            if (page > totalPages) page = totalPages;

            if (!global.userPages) global.userPages = {};
            global.userPages[chatId] = page;

            let txt = `*DAFTAR PRODUK*\n\n`;
            
            const startIndex = (page - 1) * ITEMS_PER_PAGE;
            const paginatedProducts = products.slice(startIndex, startIndex + ITEMS_PER_PAGE);

            paginatedProducts.forEach((p, i) => { 
                const absoluteNum = startIndex + i + 1; 
                txt += `${absoluteNum}. ${p.name}\n`; 
            });
            
            txt += `\nHalaman ${page}/${totalPages}\n`;
            
            let inlineLayout = [];
            let navBtns = [];
            if (page > 1) navBtns.push({ text: 'Sebelumnya', callback_data: `main_page|${page - 1}` });
            if (page < totalPages) navBtns.push({ text: 'Selanjutnya', callback_data: `main_page|${page + 1}` });
            if (navBtns.length > 0) inlineLayout.push(navBtns);

            const options = { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: inlineLayout } 
            };

            // Keyboard Bawah (Reply Keyboard) untuk Angka[cite: 4]
            let numBtns = [];
            for (let i = 1; i <= products.length; i++) {
                numBtns.push({ text: i.toString() });
            }
            let bottomLayout = chunkArray(numBtns, 5); 
            bottomLayout.unshift([{ text: '🏷️ Daftar Produk' }, { text: `💰 Saldo: Rp ${(user.balance || 0).toLocaleString('id-ID')}` }]); 

            const replyMarkupData = {
                keyboard: bottomLayout,
                resize_keyboard: true
            };

            if (editMsgId) {
                bot.editMessageText(txt, { chat_id: chatId, message_id: editMsgId, ...options }).catch(()=>{});
            } else {
                // Langsung kirim satu pesan utuh yang membawa teks, inline button, dan keyboard bawah sekaligus[cite: 4]
                bot.sendMessage(chatId, txt, {
                    ...options,
                    reply_markup: {
                        inline_keyboard: inlineLayout,
                        keyboard: bottomLayout,
                        resize_keyboard: true
                    }
                });
            }
        } finally { release(); }
    }

    // --- TAMPILAN MENU VARIASI ---
    async function renderVarMenu(product) {
        let descText = (product.description && product.description.trim() !== '') ? `_${product.description}_\n\n` : '';
        let text = `*${product.name}*\n${descText}`;
        
        let totalSold = product.variations.reduce((sum, v) => sum + (v.sold || 0), 0);
        text += `${totalSold.toLocaleString('id-ID')} Sold\n\n`;
        
        let btns = [];
        for (const v of product.variations) {
            let stock = await getStockCount(v.id);
            text += `${v.name} - Rp ${v.price.toLocaleString('id-ID')} (Stock: ${stock})\n`;
            
            if (v.wholesaleMinQty && v.wholesalePrice) {
                text += ` └ _(Beli min. ${v.wholesaleMinQty} otomatis Rp ${v.wholesalePrice.toLocaleString('id-ID')}/item)_\n`;
            }
            text += `\n`; 
            btns.push({ text: v.name, callback_data: `sel|${v.id}` });
        }
        
        text = text.trimEnd(); 
        text += `\n\n_Updated ${moment().format('HH:mm:ss')} WIB_`;
        
        let layout = chunkArray(btns, 2); 
        layout.push([{ text: 'Back', callback_data: `back_main` }]);
        return { text, reply_markup: { inline_keyboard: layout } };
    }

    function renderOrder(product, v, qty, stock) {
        let calc = calculatePrice(v, qty);
        let unitPriceDisplay = calc.isGrosir ? calc.finalPrice : calc.baseVPrice;
        let grosirNote = calc.isGrosir ? ' *(Grosir)*' : '';
        let text = `*RINGKASAN PESANAN*\n\n`;
        text += `*Produk*  : ${product.name}\n`;
        text += `*Varian*  : ${v.name}\n\n`;
        text += `*Harga Satuan* : Rp ${unitPriceDisplay.toLocaleString('id-ID')}${grosirNote}\n`;
        text += `*Stok Tersedia*  : ${stock}\n\n`;
        text += `*Jumlah Beli*  : x${qty}\n`;
        text += `*Total Pembayaran : Rp ${calc.total.toLocaleString('id-ID')}*\n\n`;
        
        return {
            text, 
            reply_markup: { inline_keyboard: [
                [
                    { text: '+ 1', callback_data: `qty|+1|${v.id}|${qty}` },
                    { text: '+ 10', callback_data: `qty|+10|${v.id}|${qty}` },
                    { text: '+ 100', callback_data: `qty|+100|${v.id}|${qty}` }
                ],
                [
                    { text: '- 1', callback_data: `qty|-1|${v.id}|${qty}` },
                    { text: '- 10', callback_data: `qty|-10|${v.id}|${qty}` },
                    { text: '- 100', callback_data: `qty|-100|${v.id}|${qty}` }
                ],
                [
                    { text: 'Refresh Stok', callback_data: `qty|+0|${v.id}|${qty}` }
                ],
                [
                    { text: 'BAYAR SALDO', callback_data: `pay|saldo|${v.id}|${qty}` },
                    { text: 'BAYAR QRIS', callback_data: `pay|qris|${v.id}|${qty}` }
                ],
                [
                    { text: 'Batal / Kembali', callback_data: `back_var|${product.slug}` }
                ]
            ]}
        };
    }

    // --- TRIGGER COMMAND & MESSAGE ---
    bot.onText(/\/start|🏠 Menu/, async (msg) => {
        return sendMainMenu(msg.chat.id, msg.from, 1);
    });

    // Perintah backup manual via Telegram admin (`/backup`)
    bot.onText(/\/backup/, async (msg) => {
        const config = await readConfig();
        if (config.adminId && msg.from.id.toString() === config.adminId.toString()) {
            bot.sendMessage(msg.chat.id, "📦 Sedang memproses backup seluruh database...");
            await sendDatabaseBackup(msg.chat.id);
        } else {
            bot.sendMessage(msg.chat.id, "❌ Perintah khusus Admin.");
        }
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;

        if (msg.text === '🏷️ Daftar Produk' || msg.text === '🏠 Menu Utama' || msg.text === '🏷️ List Produk') {
            return sendMainMenu(chatId, msg.from, 1); 
        } else if (msg.text === '💰 Cek Saldo' || (msg.text && msg.text.startsWith('💰 Saldo:'))) {
            let users = await readDB(paths.users); 
            let user = users.find(u => u.id === msg.from.id) || { balance: 0 };
            bot.sendMessage(msg.chat.id, `Saldo Akun Anda: **Rp ${(user.balance || 0).toLocaleString('id-ID')}**`, { parse_mode: 'Markdown' }); 
        } 
        else if (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('CUSTOM QUANTITY')) {
            const userId = msg.from.id;
            const newQty = parseInt(msg.text);
            
            if (isNaN(newQty) || newQty < 1) {
                return bot.sendMessage(msg.chat.id, `❌ Masukkan angka jumlah yang valid (minimal 1).`);
            }
            
            if (!global.customQtySessions || !global.customQtySessions[userId]) {
                return bot.sendMessage(msg.chat.id, `⚠️ Sesi kedaluwarsa. Silakan ulangi tombol Custom Qty dari menu pesanan.`);
            }
            
            const session = global.customQtySessions[userId];
            let products = await readDB(paths.products);
            let targetProd = null, targetVar = null;
            
            for (const p of products) {
                if (p.variations) {
                    const found = p.variations.find(v => v.id === session.varId);
                    if (found) {
                        targetProd = p;
                        targetVar = found;
                        break;
                    }
                }
            }
            
            if (!targetVar) {
                return bot.sendMessage(msg.chat.id, `❌ Variasi produk tidak ditemukan.`);
            }
            
            const stockCount = await getStockCount(targetVar.id);
            if (newQty > stockCount) {
                return bot.sendMessage(msg.chat.id, `❌ *Stok Tidak Cukup!*\n\nJumlah yang kamu minta (${newQty}) melebihi stok tersedia (${stockCount} Tersedia). Silakan masukkan angka yang lebih kecil.`, { parse_mode: 'Markdown' });
            }
            
            bot.deleteMessage(msg.chat.id, msg.message_id).catch(()=>{});
            bot.deleteMessage(msg.chat.id, msg.reply_to_message.message_id).catch(()=>{});
            
            const updatedOrder = renderOrder(targetProd, targetVar, newQty, stockCount);
            
            bot.editMessageText(updatedOrder.text, {
                chat_id: session.chatId,
                message_id: session.msgId,
                parse_mode: 'Markdown',
                reply_markup: updatedOrder.reply_markup
            }).catch(()=>{});
            
            delete global.customQtySessions[userId];
        }
    });

    // Menangani ketikan angka manual dari keyboard bawah[cite: 4]
    bot.onText(/^(\d+)$/, async (msg, match) => {
        if (msg.reply_to_message) return; // Mencegah konflik
        
        let products = await readDB(paths.products);
        let num = parseInt(match[1]);
        if (num > 0 && num <= products.length) {
            const { text, reply_markup } = await renderVarMenu(products[num - 1]);
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup });
        }
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id; 
        const msgId = query.message.message_id;
        const parts = query.data.split('|'); 
        const action = parts[0]; 

        if (action === 'main_page') {
            const page = parseInt(parts[1]);
            bot.answerCallbackQuery(query.id);
            return sendMainMenu(chatId, query.from, page, msgId);
        }

        if (action === 'back_main') { 
            bot.deleteMessage(chatId, msgId).catch(()=>{}); 
            bot.answerCallbackQuery(query.id);
            if (!global.userPages) global.userPages = {};
            let currentPage = global.userPages[chatId] || 1;
            return sendMainMenu(chatId, query.from, currentPage); 
        }

        let products = await readDB(paths.products);

        if (action === 'back_var') {
            const prod = products.find(p => p.slug === parts[1]);
            if (prod) { 
                const { text, reply_markup } = await renderVarMenu(prod); 
                bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup }).catch(()=>{}); 
            }
            return bot.answerCallbackQuery(query.id);
        }

        if (action === 'batal_qris') {
            bot.answerCallbackQuery(query.id, { text: "Pesanan dibatalkan." }); 
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
            
            if (!global.userPages) global.userPages = {};
            let currentPage = global.userPages[chatId] || 1;
            return sendMainMenu(chatId, query.from, currentPage); 
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
        
        if (!selVar && action !== 'main_page' && action !== 'back_main' && action !== 'back_var' && action !== 'refresh_var' && action !== 'batal_qris') {
            return bot.answerCallbackQuery(query.id, { text: "Error: Variasi tidak ditemukan" });
        }
        const stockCount = selVar ? await getStockCount(selVar.id) : 0;

        if (action === 'sel' || action === 'qty') {
            let qty = action === 'sel' ? 1 : parseInt(parts[3]);
            if (action === 'qty') { 
                const op = parts[1]; 
                if (op === '+1') qty += 1; 
                else if (op === '+10') qty += 10;
                else if (op === '+100') qty += 100;
                else if (op === '-1') qty -= 1;
                else if (op === '-10') qty -= 10;
                else if (op === '-100') qty -= 100;
            }
            if (qty < 1) qty = 1; 
            if (qty > stockCount) { 
                qty = stockCount; 
                bot.answerCallbackQuery(query.id, { text: "Stok maksimal telah tercapai!" }); 
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
            
            if (finalQty > stockCount || stockCount === 0) return bot.answerCallbackQuery(query.id, { text: "Maaf, stok barang sedang kosong.", show_alert: true });
            
            if (parts[1] === 'saldo') {
                const cfg = await readConfig(); 
                const prefix = cfg.trxPrefix || "BR"; 
                const release = await dbLock.acquire(); 
                try {
                    let users = await readDB(paths.users); 
                    let userIndex = users.findIndex(u => u.id === query.from.id); 
                    let user = users[userIndex];
                    
                    if ((user.balance || 0) < basePrice) {
                        bot.answerCallbackQuery(query.id, { text: "❌ Saldo Anda tidak mencukupi untuk pembelian ini.", show_alert: true });
                        return bot.sendMessage(chatId, `❌ Saldo Anda tidak mencukupi.`);
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
                    
                    let pData = await readDB(paths.products);
                    for (let pd of pData) {
                        let vr = pd.variations && pd.variations.find(x => x.id === selVar.id);
                        if (vr) { 
                            vr.sold = (vr.sold || 0) + finalQty; 
                            break; 
                        }
                    }
                    await fs.writeFile(paths.products, JSON.stringify(pData, null, 2));
                    
                    // Panggil helper
                    await finalizeOrderSuccess({
                        order_id: oid,
                        user_id: user.id,
                        var_id: selVar.id,
                        qty: finalQty,
                        total: basePrice,
                        reserved_accounts: accs,
                        msg_id: null
                    }, 'balance', 'PEMBAYARAN BERHASIL (LUNAS)');

                } finally { release(); }
            } else if (parts[1] === 'qris') {
                const cfg = await readConfig(); 
                const prefix = cfg.trxPrefix || "BR"; 
                if (!cfg.qrisString) {
                    bot.answerCallbackQuery(query.id, { text: "QRIS belum diatur oleh Admin.", show_alert: true }); 
                    return bot.sendMessage(chatId, "QRIS belum diatur oleh Admin.");
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
                    
                    let pq = await readDB(paths.pending_qris);
                    
                    const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(dynamicQrisString)}&size=400&margin=2`;
                    const cap = `*INVOICE PEMBAYARAN*\n\`${oid}\`\n\nProduk: ${selProd.name}\nVariasi: ${selVar.name}\nJumlah: ${finalQty}x\nTotal: Rp. ${finalTotal.toLocaleString('id-ID')}`;
                    
                    bot.answerCallbackQuery(query.id); 
                    bot.deleteMessage(chatId, msgId).catch(()=>{});
                    
                    const sentMsg = await bot.sendPhoto(chatId, qrUrl, { caption: cap, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Batalkan Pesanan', callback_data: `batal_qris|${oid}` }]] } });
                    
                    pq.push({ 
                        order_id: oid, 
                        user_id: query.from.id, 
                        var_id: selVar.id, 
                        qty: finalQty, 
                        total: finalTotal, 
                        reserved_accounts: resAccs, 
                        status: 'pending', 
                        date: moment().format('YYYY-MM-DD HH:mm:ss'),
                        timestamp: Date.now(),
                        msg_id: sentMsg.message_id
                    });
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
    let totalSold = orders.reduce((s, o) => s + (o.qty || 1), 0);
    
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
        totalStock: totalStock,
        totalSold: totalSold
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
        f.variations.push({ id: `var_${Date.now()}`, ...req.body, price: parseInt(req.body.price), wholesaleMinQty: null, wholesalePrice: null, sold: 0 }); 
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

app.listen(WEBHOOK_PORT, () => { 
    console.log(`🌐 Web Dashboard & Server Webhook aktif di: http://localhost:${WEBHOOK_PORT}`); 
    initDB(); 
});
