const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());

const PORT = 4000; 
const API_SECRET = "rahasia-brstore-2026"; 

const akunFile = path.join(__dirname, 'AKUN.txt');
if (!fs.existsSync(akunFile)) {
    fs.writeFileSync(akunFile, '', 'utf8');
}

let isRunning = false;
let autoRetryCount = 0;
const MAX_AUTO_RETRY = 2; // Batas pengulangan otomatis jika ada akun yang masih bandel/gagal

// Fungsi Eksekusi & Antrean
function runBotProcess(isNewTrigger = false) {
    if (isNewTrigger) {
        autoRetryCount = 0; // Reset hitungan jika ada orderan baru atau klik tombol retry manual
    }

    if (isRunning) {
        console.log(`⏳ [QUEUE] Bot sedang sibuk. Menunggu giliran...`);
        return;
    }

    try {
        if (!fs.existsSync(akunFile)) return;
        
        const content = fs.readFileSync(akunFile, 'utf8');
        // Filter baris kosong & komentar
        const accounts = content.split('\n').map(a => a.trim()).filter(a => a && !a.startsWith('//'));
        
        if (accounts.length === 0) {
            autoRetryCount = 0;
            return;
        }

        // Pengaman Anti-Infinite Loop (Mencegah VPS hang jika password akun salah/suspend)
        if (autoRetryCount > MAX_AUTO_RETRY) {
            console.log(`\n🛑 [QUEUE] Batas Auto-Retry maksimal tercapai (${MAX_AUTO_RETRY}x pengulangan).`);
            console.log(`⚠️ Sisa ${accounts.length} akun dibiarkan di AKUN.txt. Silakan cek di Panel Admin untuk tindakan manual.`);
            return;
        }

        isRunning = true;
        
        if (autoRetryCount > 0) {
            console.log(`\n🔄 [AUTO RETRY ${autoRetryCount}/${MAX_AUTO_RETRY}] Mencoba ulang ${accounts.length} akun yang belum sukses...`);
        } else {
            console.log(`\n🚀 [QUEUE] Memulai proses Auto Pay untuk ${accounts.length} akun...`);
        }
        
        const autopayProcess = spawn('xvfb-run', ['node', 'bot.min.js', '--auto']);

        autopayProcess.stdout.on('data', (data) => {
            process.stdout.write(data.toString()); 
        });

        autopayProcess.stderr.on('data', (data) => {
            process.stderr.write(`[ERROR] ${data.toString()}`);
        });

        autopayProcess.on('close', (code) => {
            console.log(`🏁 [AUTO PAY SELESAI] Proses berhenti dengan kode ${code}`);
            isRunning = false;

            // CEK OTOMATIS: Apakah masih ada akun yang tersisa di AKUN.txt setelah bot selesai?
            const sisaContent = fs.existsSync(akunFile) ? fs.readFileSync(akunFile, 'utf8') : "";
            const sisaAccounts = sisaContent.split('\n').map(a => a.trim()).filter(a => a && !a.startsWith('//'));
            
            if (sisaAccounts.length > 0) {
                autoRetryCount++;
                console.log(`⏳ [QUEUE] Ditemukan ${sisaAccounts.length} sisa akun di AKUN.txt. Auto-Retry akan berjalan dalam 10 detik...`);
                
                // Jeda 10 detik agar tidak terdeteksi spam oleh YouTube, lalu ulangi proses
                setTimeout(() => {
                    runBotProcess(false);
                }, 10000); 
            } else {
                console.log(`✅ [QUEUE] Semua akun berhasil dieksekusi dengan bersih!`);
                autoRetryCount = 0; 
            }
        });

    } catch (err) {
        console.error("❌ [QUEUE ERROR]:", err.message);
        isRunning = false;
    }
}

// 1. Endpoint Utama: Menerima akun baru
app.post('/api/trigger-autopay', (req, res) => {
    if (req.headers['x-api-key'] !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const accounts = req.body.accounts;
    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
        return res.status(400).json({ error: "Data akun tidak valid" });
    }

    const formattedAccounts = accounts.map(acc => {
        const parts = acc.split(':');
        return parts.length >= 2 ? `${parts[0].trim()} ${parts[1].trim()}` : acc;
    }).join('\n') + '\n';

    try {
        fs.appendFileSync(akunFile, formattedAccounts);
        console.log(`\n📥 [API] Menerima ${accounts.length} akun baru. Disimpan ke AKUN.txt.`);
    } catch (e) {
        return res.status(500).json({ error: "Gagal menulis ke file AKUN.txt" });
    }

    res.json({ success: true, message: "Akun berhasil diterima dan masuk antrean sistem." });
    
    // Picu sistem antrean & reset hitungan retry
    runBotProcess(true);
});

// 2. Endpoint Tambahan: Cek sisa akun di AKUN.txt
app.get('/api/check-failed', (req, res) => {
    if (req.headers['x-api-key'] !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        if (!fs.existsSync(akunFile)) {
            return res.json({ accounts: [] });
        }
        const content = fs.readFileSync(akunFile, 'utf8');
        const accounts = content.split('\n').map(a => a.trim()).filter(a => a && !a.startsWith('//'));
        res.json({ accounts });
    } catch (e) {
        res.status(500).json({ error: "Gagal membaca file AKUN.txt" });
    }
});

// 3. Endpoint Tambahan: Manual Retry Auto Pay dari Web Panel
app.post('/api/retry-autopay', (req, res) => {
    if (req.headers['x-api-key'] !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!fs.existsSync(akunFile)) {
        return res.json({ success: false, error: "File AKUN.txt tidak ditemukan" });
    }

    console.log(`🔄 [API] Web Panel meminta Manual Retry Auto Pay...`);
    res.json({ success: true, message: "Retry Auto Pay dipicu." });
    
    // Picu sistem antrean & reset hitungan retry agar bisa berjalan maksimal lagi
    runBotProcess(true);
});

app.listen(PORT, async () => {
    console.log(`🌐 Receiver API untuk Auto Pay aktif di port ${PORT}`);
});
