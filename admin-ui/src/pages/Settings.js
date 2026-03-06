import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
export default function Settings() {
    const [settings, setSettings] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);
    useEffect(() => {
        fetch('http://localhost:3001/api/settings')
            .then(res => res.json())
            .then(data => {
            setSettings(data);
            setLoading(false);
        })
            .catch(err => {
            console.error(err);
            setLoading(false);
        });
    }, []);
    const handleChange = (key, value) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };
    const handleSave = async () => {
        setSaving(true);
        setMessage(null);
        try {
            const res = await fetch('http://localhost:3001/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            if (!res.ok)
                throw new Error('Failed to save');
            setMessage({ type: 'success', text: 'Settings saved successfully!' });
        }
        catch (err) {
            setMessage({ type: 'error', text: 'Error saving settings. Check console.' });
        }
        finally {
            setSaving(false);
        }
    };
    // Allow adding new keys
    const [newKey, setNewKey] = useState('');
    const [newValue, setNewValue] = useState('');
    const handleAddSetting = () => {
        if (!newKey.trim())
            return;
        setSettings(prev => ({ ...prev, [newKey.trim().toUpperCase()]: newValue }));
        setNewKey('');
        setNewValue('');
    };
    if (loading)
        return _jsx("div", { className: "page", children: "Loading settings..." });
    return (_jsxs("div", { className: "page", children: [_jsx("h1", { children: "Configuration Settings" }), message && (_jsx("div", { className: `card ${message.type === 'error' ? 'error-card' : ''}`, style: message.type === 'success' ? { backgroundColor: '#ecfdf5', borderColor: '#10b981' } : {}, children: _jsx("p", { style: { margin: 0, color: message.type === 'success' ? '#047857' : 'inherit' }, children: message.text }) })), _jsxs("div", { className: "card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }, children: [_jsx("p", { style: { margin: 0 }, children: "Database-backed system configuration." }), _jsx("button", { onClick: handleSave, disabled: saving, style: { background: 'var(--primary-color)', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }, children: saving ? 'Saving...' : 'Save All Changes' })] }), _jsxs("table", { className: "data-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Key" }), _jsx("th", { children: "Value" })] }) }), _jsxs("tbody", { children: [Object.entries(settings).map(([key, value]) => (_jsxs("tr", { children: [_jsx("td", { style: { width: '30%' }, children: _jsx("code", { children: key }) }), _jsx("td", { children: _jsx("input", { type: "text", value: value, onChange: (e) => handleChange(key, e.target.value), style: { width: '100%', padding: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px' } }) })] }, key))), _jsxs("tr", { children: [_jsx("td", { children: _jsx("input", { type: "text", placeholder: "NEW_KEY", value: newKey, onChange: (e) => setNewKey(e.target.value), style: { width: '100%', padding: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px' } }) }), _jsxs("td", { style: { display: 'flex', gap: '0.5rem' }, children: [_jsx("input", { type: "text", placeholder: "Value", value: newValue, onChange: (e) => setNewValue(e.target.value), style: { flex: 1, padding: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px' } }), _jsx("button", { onClick: handleAddSetting, style: { background: '#e2e8f0', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }, children: "Add" })] })] })] })] })] })] }));
}
//# sourceMappingURL=Settings.js.map