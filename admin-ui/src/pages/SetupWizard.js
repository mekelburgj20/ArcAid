import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
export default function SetupWizard({ onComplete }) {
    const [step, setStep] = useState(1);
    const [config, setConfig] = useState({
        TERMINOLOGY_MODE: 'generic',
        DISCORD_BOT_TOKEN: '',
        DISCORD_CLIENT_ID: '',
        DISCORD_GUILD_ID: '',
        ISCORED_USERNAME: '',
        ISCORED_PASSWORD: '',
    });
    const [saving, setSaving] = useState(false);
    const handleChange = (e) => {
        setConfig({ ...config, [e.target.name]: e.target.value });
    };
    const handleFinish = async () => {
        setSaving(true);
        try {
            await fetch('http://localhost:3001/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...config, SETUP_COMPLETE: 'true' }),
            });
            onComplete();
        }
        catch (err) {
            console.error(err);
            alert('Failed to save configuration.');
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsx("div", { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: 'var(--bg-color)' }, children: _jsxs("div", { className: "card", style: { width: '500px', padding: '2rem' }, children: [_jsx("h2", { style: { marginTop: 0, color: 'var(--primary-color)' }, children: "ArcAid Setup Wizard" }), _jsxs("div", { style: { marginBottom: '1.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }, children: ["Step ", step, " of 3"] }), step === 1 && (_jsxs("div", { children: [_jsx("h3", { children: "1. Terminology" }), _jsx("p", { className: "small", children: "Choose the naming convention for your server." }), _jsxs("select", { name: "TERMINOLOGY_MODE", value: config.TERMINOLOGY_MODE, onChange: handleChange, style: { width: '100%', padding: '0.75rem', borderRadius: '4px', border: '1px solid var(--border-color)', marginBottom: '1rem' }, children: [_jsx("option", { value: "generic", children: "Generic (Games & Tournaments)" }), _jsx("option", { value: "legacy", children: "Pinball Legacy (Tables & Grinds)" })] }), _jsx("button", { onClick: () => setStep(2), style: btnStyle, children: "Next: Discord Setup" })] })), step === 2 && (_jsxs("div", { children: [_jsx("h3", { children: "2. Discord Credentials" }), _jsx("input", { type: "password", name: "DISCORD_BOT_TOKEN", placeholder: "Bot Token", value: config.DISCORD_BOT_TOKEN, onChange: handleChange, style: inputStyle }), _jsx("input", { type: "text", name: "DISCORD_CLIENT_ID", placeholder: "Client ID (Application ID)", value: config.DISCORD_CLIENT_ID, onChange: handleChange, style: inputStyle }), _jsx("input", { type: "text", name: "DISCORD_GUILD_ID", placeholder: "Guild ID (Server ID)", value: config.DISCORD_GUILD_ID, onChange: handleChange, style: inputStyle }), _jsxs("div", { style: { display: 'flex', gap: '1rem' }, children: [_jsx("button", { onClick: () => setStep(1), style: { ...btnStyle, background: 'var(--text-muted)' }, children: "Back" }), _jsx("button", { onClick: () => setStep(3), style: { ...btnStyle, flex: 1 }, children: "Next: iScored Setup" })] })] })), step === 3 && (_jsxs("div", { children: [_jsx("h3", { children: "3. iScored Account" }), _jsx("input", { type: "text", name: "ISCORED_USERNAME", placeholder: "iScored Username", value: config.ISCORED_USERNAME, onChange: handleChange, style: inputStyle }), _jsx("input", { type: "password", name: "ISCORED_PASSWORD", placeholder: "iScored Password", value: config.ISCORED_PASSWORD, onChange: handleChange, style: inputStyle }), _jsxs("div", { style: { display: 'flex', gap: '1rem' }, children: [_jsx("button", { onClick: () => setStep(2), style: { ...btnStyle, background: 'var(--text-muted)' }, disabled: saving, children: "Back" }), _jsx("button", { onClick: handleFinish, disabled: saving, style: { ...btnStyle, flex: 1 }, children: saving ? 'Saving...' : 'Finish Setup' })] })] }))] }) }));
}
const inputStyle = { width: '100%', padding: '0.75rem', borderRadius: '4px', border: '1px solid var(--border-color)', marginBottom: '1rem', boxSizing: 'border-box' };
const btnStyle = { background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 };
//# sourceMappingURL=SetupWizard.js.map