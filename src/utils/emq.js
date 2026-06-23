function calculateEMQ(userData) {
    if (!userData) return 0;
    let score = 0;
    if (userData.em) score += 2.0;
    if (userData.ph) score += 2.0;
    if (userData.external_id) score += 1.5;
    if (userData.fn) score += 1.0;
    if (userData.ln) score += 1.0;
    if (userData.ct) score += 0.5;
    if (userData.st) score += 0.5;
    if (userData.zp) score += 0.5;
    if (userData.country) score += 0.5;
    if (userData.fbp || userData.fbc) score += 0.5;
    return Math.min(score, 10.0).toFixed(1);
}

function missingMatchSignals(userData) {
    const missing = [];
    if (!userData?.em) missing.push('email');
    if (!userData?.ph) missing.push('phone');
    if (!userData?.external_id) missing.push('external_id');
    if (!userData?.fbp) missing.push('fbp');
    if (!userData?.fbc) missing.push('fbc');
    if (!userData?.client_ip_address) missing.push('client_ip_address');
    if (!userData?.client_user_agent) missing.push('client_user_agent');
    if (!userData?.fn) missing.push('first_name');
    if (!userData?.ln) missing.push('last_name');
    if (!userData?.ct) missing.push('city');
    if (!userData?.st) missing.push('state');
    if (!userData?.zp) missing.push('zip');
    if (!userData?.country) missing.push('country');
    return missing;
}

module.exports = { calculateEMQ, missingMatchSignals };
