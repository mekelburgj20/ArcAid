import { useState, useEffect } from 'react';

type Frequency = 'daily' | 'weekly' | 'monthly';

const DAYS_OF_WEEK = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];

interface ScheduleBuilderProps {
  value: { cron: string; timezone: string };
  onChange: (val: { cron: string; timezone: string }) => void;
}

/** Attempts to parse a cron expression back into UI-friendly state. */
function parseCron(cron: string): { frequency: Frequency; hour: number; minute: number; dayOfWeek: number; dayOfMonth: number } {
  const parts = cron.split(' ');
  const minute = parseInt(parts[0]) || 0;
  const hour = parseInt(parts[1]) || 0;
  const dom = parts[2];
  const dow = parts[4];

  if (dom !== '*' && parseInt(dom) >= 1) {
    return { frequency: 'monthly', hour, minute, dayOfWeek: 0, dayOfMonth: parseInt(dom) };
  }
  if (dow !== '*') {
    return { frequency: 'weekly', hour, minute, dayOfWeek: parseInt(dow), dayOfMonth: 1 };
  }
  return { frequency: 'daily', hour, minute, dayOfWeek: 0, dayOfMonth: 1 };
}

function buildCron(frequency: Frequency, hour: number, minute: number, dayOfWeek: number, dayOfMonth: number): string {
  switch (frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case 'monthly':
      return `${minute} ${hour} ${dayOfMonth} * *`;
  }
}

function formatSchedulePreview(frequency: Frequency, hour: number, minute: number, dayOfWeek: number, dayOfMonth: number, timezone: string): string {
  const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  const tz = timezone.split('/').pop()?.replace(/_/g, ' ') || timezone;

  switch (frequency) {
    case 'daily':
      return `Every day at ${time} ${tz}`;
    case 'weekly': {
      const dayName = DAYS_OF_WEEK.find(d => d.value === dayOfWeek)?.label || '??';
      return `Every ${dayName} at ${time} ${tz}`;
    }
    case 'monthly':
      return `${ordinal(dayOfMonth)} of every month at ${time} ${tz}`;
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const parsed = parseCron(value.cron);
  const [frequency, setFrequency] = useState<Frequency>(parsed.frequency);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [dayOfWeek, setDayOfWeek] = useState(parsed.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(parsed.dayOfMonth);
  const [timezone, setTimezone] = useState(value.timezone || 'America/Chicago');

  useEffect(() => {
    const cron = buildCron(frequency, hour, minute, dayOfWeek, dayOfMonth);
    onChange({ cron, timezone });
  }, [frequency, hour, minute, dayOfWeek, dayOfMonth, timezone]);

  const inputClass = 'bg-raised border border-border rounded px-3 py-2 text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors';
  const selectClass = `${inputClass} cursor-pointer`;

  return (
    <div className="space-y-4">
      {/* Frequency row */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Repeats</label>
          <select value={frequency} onChange={e => setFrequency(e.target.value as Frequency)} className={selectClass}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        {/* Day of week (weekly only) */}
        {frequency === 'weekly' && (
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Day</label>
            <div className="flex gap-1">
              {DAYS_OF_WEEK.map(d => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setDayOfWeek(d.value)}
                  className={`w-9 h-9 rounded text-xs font-medium transition-all border cursor-pointer ${
                    dayOfWeek === d.value
                      ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                      : 'bg-raised border-border text-muted hover:border-neon-cyan/50'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Day of month (monthly only) */}
        {frequency === 'monthly' && (
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Day of Month</label>
            <select value={dayOfMonth} onChange={e => setDayOfMonth(parseInt(e.target.value))} className={selectClass}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                <option key={d} value={d}>{ordinal(d)}</option>
              ))}
            </select>
          </div>
        )}

        {/* Time */}
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Time</label>
          <div className="flex gap-1 items-center">
            <select value={hour} onChange={e => setHour(parseInt(e.target.value))} className={`${selectClass} w-16`}>
              {Array.from({ length: 24 }, (_, i) => i).map(h => (
                <option key={h} value={h}>{h.toString().padStart(2, '0')}</option>
              ))}
            </select>
            <span className="text-muted font-bold">:</span>
            <select value={minute} onChange={e => setMinute(parseInt(e.target.value))} className={`${selectClass} w-16`}>
              {[0, 1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Timezone */}
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Timezone</label>
          <select value={timezone} onChange={e => setTimezone(e.target.value)} className={selectClass}>
            {TIMEZONES.map(tz => (
              <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Preview */}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-neon-green">
          {formatSchedulePreview(frequency, hour, minute, dayOfWeek, dayOfMonth, timezone)}
        </span>
        <code className="text-faint text-xs font-mono">{buildCron(frequency, hour, minute, dayOfWeek, dayOfMonth)}</code>
      </div>
    </div>
  );
}
