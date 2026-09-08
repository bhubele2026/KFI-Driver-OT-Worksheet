import { useLocation } from "wouter";

/**
 * The dispatcher's way into the matching tables.
 *
 * Settings is the owner's gear and stays that way. But when v93 moved Settings
 * into the chrome, the mapping pages went with it — and they are the tools a
 * dispatcher needs the moment an import puts hours on the wrong person, or
 * misses someone. This sits beside the gear for anyone with admin.
 */
export function MappingsButton({ className }: { className?: string }) {
  const [, setLocation] = useLocation();
  return (
    <button
      type="button"
      onClick={() => setLocation("/mappings")}
      title="Mappings"
      aria-label="Mappings"
      className={`press grid h-9 w-9 place-items-center rounded-md text-white/70 hover:bg-white/10 hover:text-white ${className ?? ""}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M8.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h5.5" />
      </svg>
    </button>
  );
}
