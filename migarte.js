const fs = require('fs');
const path = require('path');

const balancesPath = path.join(__dirname, 'data', 'balances.json');
const usersPath = path.join(__dirname, 'data', 'users.json');
const newUsersPath = path.join(__dirname, 'data', 'users_baru.json');

try {
    const balances = JSON.parse(fs.readFileSync(balancesPath, 'utf8'));
    const oldUsers = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    const newUsers = oldUsers.map(user => {
        // Deteksi ID secara aman (mendukung format baru 'id' maupun format lama 'userId')
        const idAsli = user.userId || user.id; 
        
        // Konversi ke string dengan aman (mencegah error toString)
        const idString = idAsli ? idAsli.toString() : "unknown";

        return {
            id: idAsli,
            username: user.username || "NoUsername",
            first_name: user.firstName || user.first_name || "User",
            balance: balances[idString] || 0,
            trx_count: 0,
            joined_at: user.firstSeen || user.joined_at || "Unknown"
        };
    });

    // Filter otomatis: Buang data sampah yang tidak memiliki ID
    const validUsers = newUsers.filter(u => u.id !== undefined && u.id !== null);

    fs.writeFileSync(newUsersPath, JSON.stringify(validUsers, null, 2));
    
    console.log(`✅ Sukses! ${validUsers.length} data pengguna valid berhasil diselamatkan dan diperbarui.`);
    console.log(`📂 Silakan cek file "users_baru.json" di folder data.`);
} catch (error) {
    console.error("❌ Terjadi kesalahan:", error.message);
}