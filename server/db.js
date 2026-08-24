const fs = require('fs');
const path = require('path');

// Save the database file in the same directory where the executable is run
const dbPath = path.join(process.cwd(), 'giga_limit_db.json');
const dbTmpPath = path.join(process.cwd(), 'giga_limit_db.json.tmp');
const dbBakPath = path.join(process.cwd(), 'giga_limit_db.json.bak');

let data = {
    settings: {
        admin_password: 'admin123',
        global_daily_limit_mb: 1024,
        global_weekly_limit_mb: 7168,
        target_apps: ["instagram", "whatsapp", "facebook", "snapchat", "tiktok"],
        auto_renew_daily_enabled: true,
        auto_renew_daily_time: "00:00",
        auto_renew_weekly_enabled: true,
        auto_renew_weekly_time: "00:00",
        throttle_enabled: true,
        throttle_speed_kbps: 50
    },
    users: [], // { id, name, device_id, current_ip, status, daily_limit_mb }
    usage: [] // { user_id, date, bytes_used }
};

// Helper: try to load a JSON file safely, return parsed data or null
const tryLoadJson = (filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content && content.trim().length > 0) {
                return JSON.parse(content);
            }
        }
    } catch (e) {
        // corrupted or unreadable
    }
    return null;
};

// Startup recovery: try main → backup → tmp → fresh
let fileData = tryLoadJson(dbPath);
if (!fileData) {
    console.warn('[DB] Main db file corrupted or missing, trying backup...');
    fileData = tryLoadJson(dbBakPath);
    if (fileData) {
        console.log('[DB] Recovered from backup file.');
        // Restore backup as main
        try { fs.copyFileSync(dbBakPath, dbPath); } catch (e) {}
    }
}
if (!fileData) {
    fileData = tryLoadJson(dbTmpPath);
    if (fileData) {
        console.log('[DB] Recovered from tmp file.');
        try { fs.copyFileSync(dbTmpPath, dbPath); } catch (e) {}
    }
}
if (fileData) {
    data = { ...data, ...fileData };
    if (data.settings && data.settings.global_total_bytes_used === undefined) {
        data.settings.global_total_bytes_used = 0;
    }
    if (data.settings && data.settings.target_apps === undefined) {
        data.settings.target_apps = ["instagram", "whatsapp", "facebook", "snapchat", "tiktok"];
    }
} else {
    console.log('[DB] No valid db file found, starting fresh.');
}

const getLocalDateString = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const save = () => {
    try {
        const jsonStr = JSON.stringify(data, null, 2);
        // Write to tmp file first
        fs.writeFileSync(dbTmpPath, jsonStr);
        // Backup current main file before overwriting
        if (fs.existsSync(dbPath)) {
            try { fs.copyFileSync(dbPath, dbBakPath); } catch (e) {}
        }
        // Copy tmp → main (works on Windows/OneDrive unlike rename)
        fs.copyFileSync(dbTmpPath, dbPath);
        // Clean up tmp
        try { fs.unlinkSync(dbTmpPath); } catch (e) {}
    } catch (e) {
        console.error('[DB] Error saving database:', e.message);
    }
};

// Ensure initial save
save();

module.exports = {
    getSetting: (key) => data.settings[key],
    
    registerUser: (name, device_id, ip, default_limit) => {
        let user = data.users.find(u => u.device_id === device_id);
        if (!user) {
            let existingIpUser = data.users.find(u => u.current_ip === ip);
            if (existingIpUser) {
                existingIpUser.device_id = device_id;
                if (name) existingIpUser.name = name;
                user = existingIpUser;
            } else {
                const maxId = data.users.reduce((max, u) => Math.max(max, u.id), 0);
                user = {
                    id: maxId + 1,
                    name,
                    device_id,
                    current_ip: ip,
                    daily_limit_mb: default_limit,
                    weekly_limit_mb: default_limit * 7,
                    status: 'active',
                    registered_at: getLocalDateString()
                };
                data.users.push(user);
            }
        } else {
            user.current_ip = ip;
            if (name) user.name = name;
        }
        save();
        return user;
    },

    updateUserIp: (device_id, current_ip) => {
        let user = data.users.find(u => u.device_id === device_id);
        if (user) {
            user.current_ip = current_ip;
            save();
        }
    },

    getUserByDeviceId: (device_id) => data.users.find(u => u.device_id === device_id),
    
    getUserByIp: (ip) => data.users.find(u => u.current_ip === ip),

    setNotification: (id, message) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.pending_notification = message;
            save();
            return true;
        }
        return false;
    },

    clearNotification: (id) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            delete user.pending_notification;
            save();
            return true;
        }
        return false;
    },

    setMonitoring: (id, enabled) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.monitoring_enabled = enabled;
            save();
            return true;
        }
        return false;
    },

    getUsage: (user_id, date) => {
        let usage = data.usage.find(u => u.user_id === user_id && u.date === date);
        return usage ? usage.bytes_used : 0;
    },

    updateUsage: (user_id, date, bytes) => {
        let usage = data.usage.find(u => u.user_id === user_id && u.date === date);
        if (usage) {
            usage.bytes_used += bytes;
        } else {
            data.usage.push({ user_id, date, bytes_used: bytes });
        }
        if (data.settings.global_total_bytes_used === undefined) data.settings.global_total_bytes_used = 0;
        data.settings.global_total_bytes_used += bytes;
        save();
    },

    getWeeklyUsage: (user_id) => {
        const todayStr = getLocalDateString();
        const parts = todayStr.split('-');
        const today = new Date(parts[0], parts[1] - 1, parts[2]);
        const day = today.getDay(); // 0 = Sun, 6 = Sat
        const daysSinceSaturday = (day + 1) % 7; 
        
        let total = 0;
        for (let i = 0; i <= daysSinceSaturday; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let usage = data.usage.find(u => u.user_id === user_id && u.date === dateStr);
            if (usage) total += usage.bytes_used;
        }
        let user = data.users.find(u => u.id === user_id);
        if (user && user.weekly_offset) total += user.weekly_offset;
        return Math.max(0, total);
    },

    getUsersWithUsage: (date) => {
        return data.users.map(u => {
            let usage = data.usage.find(us => us.user_id === u.id && us.date === date);
            return {
                ...u,
                bytes_used: usage ? usage.bytes_used : 0,
                weekly_bytes_used: module.exports.getWeeklyUsage(u.id)
            };
        });
    },

    updateUserSettings: (id, status, daily_limit_mb, weekly_limit_mb) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.status = status;
            user.daily_limit_mb = parseInt(daily_limit_mb);
            if(weekly_limit_mb) user.weekly_limit_mb = parseInt(weekly_limit_mb);
            save();
            return true;
        }
        return false;
    },

    setUsageDirectly: (id, daily_bytes, weekly_bytes) => {
        const today = getLocalDateString();
        let user = data.users.find(u => u.id === parseInt(id));
        if (!user) return false;

        let usage = data.usage.find(u => u.user_id === parseInt(id) && u.date === today);
        if (usage) {
            usage.bytes_used = parseInt(daily_bytes);
        } else {
            data.usage.push({ user_id: parseInt(id), date: today, bytes_used: parseInt(daily_bytes) });
        }

        // Calculate current natural weekly usage (without offset)
        let naturalWeekly = module.exports.getWeeklyUsage(parseInt(id)) - (user.weekly_offset || 0);
        user.weekly_offset = parseInt(weekly_bytes) - naturalWeekly;
        save();
        return true;
    },

    resetUsage: (user_id, date) => {
        let usage = data.usage.find(u => u.user_id === parseInt(user_id) && u.date === date);
        if (usage) {
            usage.bytes_used = 0;
            save();
        }
    },

    resetWeeklyUsage: (user_id) => {
        const todayStr = getLocalDateString();
        const today = new Date(todayStr);
        const day = today.getDay(); // 0 = Sun, 6 = Sat
        const daysSinceSaturday = (day + 1) % 7; 
        
        for (let i = 0; i <= daysSinceSaturday; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let usage = data.usage.find(u => u.user_id === parseInt(user_id) && u.date === dateStr);
            if (usage) usage.bytes_used = 0;
        }
        save();
    },

    updateGlobalLimit: (daily_limit, weekly_limit) => {
        const old_daily = data.settings.global_daily_limit_mb;
        const old_weekly = data.settings.global_weekly_limit_mb || (old_daily * 7);
        
        data.settings.global_daily_limit_mb = parseInt(daily_limit);
        data.settings.global_weekly_limit_mb = parseInt(weekly_limit);

        // Apply to users who hadn't been manually customized
        data.users.forEach(u => {
            if (u.daily_limit_mb === old_daily && (u.weekly_limit_mb === old_weekly || !u.weekly_limit_mb)) {
                u.daily_limit_mb = data.settings.global_daily_limit_mb;
                u.weekly_limit_mb = data.settings.global_weekly_limit_mb;
            }
        });
        save();
    },

    resetUserToDefault: (id) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.daily_limit_mb = data.settings.global_daily_limit_mb;
            user.weekly_limit_mb = data.settings.global_weekly_limit_mb || (data.settings.global_daily_limit_mb * 7);
            save();
            return true;
        }
        return false;
    },

    getLocalDateString,
    
    getGlobalTotal: () => data.settings.global_total_bytes_used || 0,
    
    resetGlobalTotal: () => {
        data.settings.global_total_bytes_used = 0;
        save();
    },

    deleteUser: (id) => {
        const initialLength = data.users.length;
        data.users = data.users.filter(u => u.id !== parseInt(id));
        data.usage = data.usage.filter(u => u.user_id !== parseInt(id));
        if (data.users.length < initialLength) {
            save();
            return true;
        }
        return false;
    },

    resetAllDailyUsage: () => {
        const today = getLocalDateString();
        data.users.forEach(user => {
            let usage = data.usage.find(u => u.user_id === user.id && u.date === today);
            if (usage) {
                usage.bytes_used = 0;
            } else {
                data.usage.push({ user_id: user.id, date: today, bytes_used: 0 });
            }
        });
        save();
        console.log(`[Auto-Renew] Daily usage reset for all users at ${new Date().toLocaleTimeString()}`);
    },

    resetAllWeeklyUsage: () => {
        const todayStr = getLocalDateString();
        const today = new Date(todayStr);
        const day = today.getDay();
        const daysSinceSaturday = (day + 1) % 7;

        data.users.forEach(user => {
            for (let i = 0; i <= daysSinceSaturday; i++) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                let usage = data.usage.find(u => u.user_id === user.id && u.date === dateStr);
                if (usage) usage.bytes_used = 0;
            }
            user.weekly_offset = 0;
        });
        save();
        console.log(`[Auto-Renew] Weekly usage reset for all users at ${new Date().toLocaleTimeString()}`);
    },

    getAutoRenewSettings: () => ({
        auto_renew_daily_enabled: data.settings.auto_renew_daily_enabled !== false,
        auto_renew_daily_time: data.settings.auto_renew_daily_time || "00:00",
        auto_renew_weekly_enabled: data.settings.auto_renew_weekly_enabled !== false,
        auto_renew_weekly_time: data.settings.auto_renew_weekly_time || "00:00"
    }),

    setAutoRenewSettings: (settings) => {
        if (settings.auto_renew_daily_enabled !== undefined) data.settings.auto_renew_daily_enabled = settings.auto_renew_daily_enabled;
        if (settings.auto_renew_daily_time !== undefined) data.settings.auto_renew_daily_time = settings.auto_renew_daily_time;
        if (settings.auto_renew_weekly_enabled !== undefined) data.settings.auto_renew_weekly_enabled = settings.auto_renew_weekly_enabled;
        if (settings.auto_renew_weekly_time !== undefined) data.settings.auto_renew_weekly_time = settings.auto_renew_weekly_time;
        save();
    },

    getThrottleSettings: () => ({
        throttle_enabled: data.settings.throttle_enabled !== false,
        throttle_speed_kbps: data.settings.throttle_speed_kbps || 50
    }),

    setThrottleSettings: (settings) => {
        if (settings.throttle_enabled !== undefined) data.settings.throttle_enabled = settings.throttle_enabled;
        if (settings.throttle_speed_kbps !== undefined) data.settings.throttle_speed_kbps = parseInt(settings.throttle_speed_kbps);
        save();
    }
};
