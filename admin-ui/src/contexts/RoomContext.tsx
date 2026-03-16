import { createContext, useContext } from 'react';

interface RoomContextType {
    roomId: string;
    roomSlug: string;
    roomName: string;
}

const RoomContext = createContext<RoomContextType | null>(null);

/** Get room context. Throws if not inside a RoomProvider. */
export function useRoom() {
    const ctx = useContext(RoomContext);
    if (!ctx) throw new Error('useRoom must be used within RoomProvider');
    return ctx;
}

/** Get room context or null if not inside a RoomProvider. */
export function useOptionalRoom() {
    return useContext(RoomContext);
}

export { RoomContext };
export type { RoomContextType };
