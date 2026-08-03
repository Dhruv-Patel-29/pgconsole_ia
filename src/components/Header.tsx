import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { ConnectionSwitcher } from './ConnectionSwitcher';
import { DatabaseSwitcher } from './DatabaseSwitcher';
import { Menu, MenuTrigger, MenuPopup, MenuItem } from './ui/menu';
import { useSession, signOut } from '@/lib/auth-client';
import { useOwner } from '@/hooks/useOwner';
import { useSetting } from '@/hooks/useSetting';
import { useConnections } from '@/hooks/useQuery';
import UserAvatar from './UserAvatar';
import logoFull from '@/assets/logo-light-full.svg';
import logoIcon from '@/assets/logo-light-icon.svg';

interface HeaderProps {
  selectedConnectionId: string
}

// ~10% opacity (hex alpha) for a subtle tint wash that keeps dark text legible.
const TINT_ALPHA = '1A';

// Normalize a hex color to 6 digits without the leading #, so the caller can append an alpha suffix.
function expandHex(hex: string): string {
  const h = hex.replace('#', '');
  return h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
}

export default function Header({ selectedConnectionId }: HeaderProps) {
  const navigate = useNavigate();
  const { user, authEnabled } = useSession();
  const isOwner = useOwner();
  const { branding } = useSetting();
  const { data: connections } = useConnections();

  const isGuest = user?.email === 'guest';
  const showSignIn = !user && authEnabled;

  // Per-connection environment tint: subtle background wash + full-strength bottom border,
  // so dark header text stays legible for any user-chosen hue.
  const tint = connections?.find((c) => c.id === selectedConnectionId)?.color;
  const tintStyle = tint
    ? { backgroundColor: `#${expandHex(tint)}${TINT_ALPHA}`, borderBottom: `2px solid ${tint}` }
    : undefined;

  const handleSignOut = async () => {
    await signOut();
    window.location.href = '/signin';
  };

  return (
    <header
      className={`h-12 flex items-center px-3 justify-between ${tint ? '' : 'bg-gray-100 border-b border-gray-300'}`}
      style={tintStyle}
    >
      {/* Grouped so the header's justify-between keeps two children, not three. */}
      <div className="flex min-w-0 items-center gap-1">
        <ConnectionSwitcher selectedConnectionId={selectedConnectionId} />
        <DatabaseSwitcher selectedConnectionId={selectedConnectionId} />
      </div>

      <div className="flex items-center gap-1.5">
        {branding?.logo ? (
          <a
            href={branding.logo_link || '/'}
            className="flex items-center justify-center hover:opacity-80"
          >
            <img src={branding.logo} alt="Logo" className="h-7.5" />
          </a>
        ) : (
          // Identity, not a control. The logo is the only place the product is named, so the
          // alt text carries that name for anyone not seeing the mark.
          //
          // Two variants because the lockup is 5.9:1 — at 176px it crowded the connection and
          // database it shares this bar with, and on a narrow window it covered them outright.
          // Knowing which database you are pointed at matters more than the wordmark, so the
          // mark alone holds the narrow case. Only one is ever rendered, so the repeated alt
          // is never announced twice.
          <>
            <img src={logoIcon} alt="InfoAnalytica" className="h-7 sm:hidden" />
            <img src={logoFull} alt="InfoAnalytica" className="hidden h-6 sm:block" />
          </>
        )}

        {user && !isGuest ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  className="flex items-center hover:opacity-80 transition-opacity"
                  aria-label="User menu"
                >
                  <UserAvatar user={user} size="sm" />
                </button>
              }
            />
            <MenuPopup align="end" side="bottom">
              <div className="px-3 py-2 border-b border-gray-200">
                <div className="text-sm font-medium text-gray-900">{user.name}</div>
                <div className="text-xs text-gray-500">
                  {user.name !== user.email && <span>{user.email}</span>}
                  {isOwner && <span className="ml-1 text-primary font-medium">(Owner)</span>}
                </div>
              </div>
              <MenuItem onClick={handleSignOut}>
                <LogOut size={14} />
                Sign Out
              </MenuItem>
              <div className="px-3 py-2 border-t border-gray-200">
                <div className="text-xs text-gray-400">
                  v{__APP_VERSION__} ({__GIT_COMMIT__}) &middot; {new Date(__BUILD_DATE__).toLocaleDateString()}
                </div>
              </div>
            </MenuPopup>
          </Menu>
        ) : showSignIn ? (
          <button
            className="text-xs text-gray-500 hover:text-gray-700 transition-colors px-2"
            onClick={() => navigate('/signin')}
          >
            Sign In
          </button>
        ) : null}
      </div>
    </header>
  );
}
