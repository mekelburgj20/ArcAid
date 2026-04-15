import AnnouncementCard from './AnnouncementCard';

interface Announcement {
  id: string;
  title: string;
  body: string | null;
  image_url: string | null;
  cta_url: string | null;
  cta_label: string | null;
  type: string;
  event_datetime: string | null;
}

export default function AnnouncementsRail({ announcements }: { announcements: Announcement[] }) {
  if (!announcements || announcements.length === 0) return null;

  return (
    <div className="-mx-4 sm:-mx-6 overflow-x-auto">
      <div className="flex gap-3 px-4 sm:px-6 pb-2">
        {announcements.map(a => (
          <AnnouncementCard key={a.id} announcement={a} />
        ))}
      </div>
    </div>
  );
}
