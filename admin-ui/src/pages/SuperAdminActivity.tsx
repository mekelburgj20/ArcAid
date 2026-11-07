import ActivityTimeline from '../components/ActivityTimeline';

/**
 * Super-admin -> Activity (G14, v2.227.0, ADR 0037): every room's activity
 * log plus the room-less rows (plays that went to Global or matched nothing,
 * sync jobs, iScored poller and bot errors), with a room filter and the
 * count of log writes that failed since boot.
 */
export default function SuperAdminActivity() {
  return (
    <div>
      <h1 className="font-display text-2xl font-bold text-primary mb-2">Activity</h1>
      <p className="text-sm text-muted mb-6">
        Every room, plus server-level and Global-only events. Last 90 days.
      </p>
      <ActivityTimeline mode="super" />
    </div>
  );
}
