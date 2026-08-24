import { useParams } from 'react-router-dom';
import EventDetail from './EventDetail';

/**
 * `/throwdown/:code` — a room-less player challenge (v2.136.0, ADR 0018).
 *
 * Deliberately a three-line wrapper. A Throwdown IS a Live Event with no room,
 * so it renders the very same component; giving it its own page would mean a
 * second copy of the boards, the standings and the countdown, and those two
 * copies would drift apart within a release.
 *
 * The route sits OUTSIDE the `/:slug` group because there is no slug — the
 * code is the whole address, which is what makes the link shareable by someone
 * who has never heard of game rooms.
 */
export default function ThrowdownDetail() {
    const { code } = useParams<{ code: string }>();
    return <EventDetail throwdownCode={code} />;
}
