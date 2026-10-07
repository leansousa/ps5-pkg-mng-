import { useRef, useState } from 'react';
import { pollStatus } from '../api/installer';

// Installer status is a display snapshot. Scheduling belongs to useInstallQueue
// and the backend; there is no browser-persisted base/update batch state.
export function useInstaller() {
  const [installerStatus, setInstallerStatus] = useState({ is_installing: false, status: 'idle', progress: 0,
    downloaded_bytes: 0, total_bytes: 0, pkg_path: '', title_id: '', waiting_for_disc: false });
  const [initialStatusLoaded, setInitialStatusLoaded] = useState(false);
  const installerStatusRef = useRef(installerStatus);
  installerStatusRef.current = installerStatus;
  const inFlight = useRef(false);
  const fetchStatus = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await pollStatus();
      setInstallerStatus(data);
      setInitialStatusLoaded(true);
    } catch (e) { /* Reconnect handling belongs to App. */ }
    finally { inFlight.current = false; }
  };
  const isWaitingForPart = Boolean(installerStatus.is_installing && installerStatus.waiting_for_disc);
  return { installerStatus, installerStatusRef, initialStatusLoaded, fetchStatus,
    isWaitingForPart, isInstalling: Boolean(installerStatus.is_installing) };
}
