import { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api';
import NeonButton from '../components/NeonButton';

type LogLevel = 'ALL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

const levelColors: Record<string, string> = {
  ERROR: 'text-neon-magenta',
  WARN: 'text-neon-amber',
  INFO: 'text-primary',
  DEBUG: 'text-muted',
};

export default function Logs() {
  const [logs, setLogs] = useState<string>('');
  const [filter, setFilter] = useState<LogLevel>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const [search, setSearch] = useState('');
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      const data = await api.get<{ logs: string }>('/logs');
      setLogs(data.logs);
    } catch {
      setLogs('Failed to fetch logs. Is the backend running?');
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const lines = logs.split('\n').filter(Boolean);
  const filteredLines = lines.filter(line => {
    if (filter !== 'ALL') {
      if (!line.includes(`[${filter}]`)) return false;
    }
    if (search) {
      if (!line.toLowerCase().includes(search.toLowerCase())) return false;
    }
    return true;
  });

  const downloadLogs = () => {
    const blob = new Blob([logs], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arcaid-logs-${new Date().toISOString().split('T')[0]}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const colorize = (line: string) => {
    for (const [level, color] of Object.entries(levelColors)) {
      if (line.includes(`[${level}]`)) return color;
    }
    return 'text-muted';
  };

  const filterChips: LogLevel[] = ['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG'];
  const chipColors: Record<LogLevel, string> = {
    ALL: 'border-border text-muted',
    ERROR: 'border-neon-magenta/40 text-neon-magenta',
    WARN: 'border-neon-amber/40 text-neon-amber',
    INFO: 'border-neon-cyan/40 text-neon-cyan',
    DEBUG: 'border-border text-faint',
  };

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-2xl font-bold">Activity Logs</h1>
        <div className="flex gap-2">
          <NeonButton variant="ghost" onClick={() => setAutoScroll(!autoScroll)} className="text-xs">
            Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
          </NeonButton>
          <NeonButton variant="secondary" onClick={downloadLogs} className="text-xs">Download</NeonButton>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex gap-1">
          {filterChips.map(level => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={`px-2.5 py-1 rounded border text-xs font-medium cursor-pointer transition-all ${
                filter === level ? `${chipColors[level]} bg-raised` : 'border-transparent text-faint hover:text-muted'
              }`}
            >
              {level}
            </button>
          ))}
        </div>
        <input
          type="text" placeholder="Search logs..." value={search} onChange={e => setSearch(e.target.value)}
          className="px-3 py-1.5 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors flex-1 max-w-xs"
        />
      </div>

      {/* Log Output */}
      <div className="flex-1 bg-surface border border-border rounded-lg overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {filteredLines.map((line, i) => (
          <div key={i} className={`${colorize(line)} whitespace-pre-wrap`}>{line}</div>
        ))}
        {filteredLines.length === 0 && <span className="text-faint">No logs matching filter.</span>}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
