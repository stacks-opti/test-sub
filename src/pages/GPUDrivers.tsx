import { useState, useEffect } from 'react';

export default function GPUDrivers() {
  const [isReinstalling, setIsReinstalling] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);
  const [eta, setEta] = useState('');
  const [activeOperation, setActiveOperation] = useState(null);

  const handleForceReinstall = async () => {
    setIsReinstalling(true);
    setActiveOperation('driver');
    setShowOverlay(true);
    setProgress(0);
    setStatusMessage('Preparing driver reinstallation...');
    setEta('Estimating time...');

    try {
      const result = await window.electron.invoke('force-reinstall-gpu-driver');
      setProgress(100);
      setStatusMessage(result.success ? 'Driver reinstalled successfully!' : `Error: ${result.error}`);
      setEta('');
    } catch (error) {
      setStatusMessage(`Failed: ${error}`);
    } finally {
      setTimeout(() => {
        setIsReinstalling(false);
        setShowOverlay(false);
        setActiveOperation(null);
      }, 3000);
    }
  };

  const handleRunAllUpdates = async () => {
    setIsUpdating(true);
    setActiveOperation('windows');
    setShowOverlay(true);
    setProgress(0);
    setStatusMessage('Starting Windows Update process...');
    setEta('Estimating time...');

    try {
      const result = await window.electron.invoke('run-all-windows-updates');
      setProgress(100);
      setStatusMessage(result.message || 'Update process completed');
      setEta('');
    } catch (error) {
      setStatusMessage(`Failed: ${error}`);
    } finally {
      setTimeout(() => {
        setIsUpdating(false);
        setShowOverlay(false);
        setActiveOperation(null);
      }, 3000);
    }
  };

  useEffect(() => {
    const handleDriverProgress = (_event, data) => {
      if (activeOperation === 'driver') {
        setProgress(data.progress);
        setStatusMessage(data.message);
        if (data.eta) setEta(data.eta);
      }
    };

    const handleUpdateProgress = (_event, data) => {
      if (activeOperation === 'windows') {
        setProgress(data.progress);
        setStatusMessage(data.message);
        if (data.eta) setEta(data.eta);
      }
    };

    window.electron.on('driver-reinstall-progress', handleDriverProgress);
    window.electron.on('windows-update-progress', handleUpdateProgress);

    return () => {
      window.electron.off('driver-reinstall-progress', handleDriverProgress);
      window.electron.off('windows-update-progress', handleUpdateProgress);
    };
  }, [activeOperation]);

  return (
    <div className="min-h-screen bg-black p-6">
      {showOverlay && (
        <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-zinc-900 border-2 border-red-600 rounded-lg p-8 max-w-md w-full mx-4 shadow-2xl shadow-red-600/20">
            <div className="text-center">
              <div className="relative mx-auto mb-6 h-20 w-20">
                <div className="absolute inset-0 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div>
                <div className="absolute inset-2 border-4 border-red-400 border-b-transparent rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1s' }}></div>
              </div>
              <p className="text-xl font-bold text-white mb-2">{statusMessage}</p>
              {eta && <p className="text-sm text-red-400 mb-4">{eta}</p>}
              
              {/* Progress bar */}
              <div className="mt-6 bg-zinc-800 rounded-full h-3 border border-zinc-700 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-red-600 via-red-500 to-red-600 transition-all duration-500 ease-out relative"
                  style={{ width: `${progress}%` }}
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse"></div>
                </div>
              </div>
              <p className="text-sm text-zinc-400 mt-3 font-mono">{progress}% Complete</p>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">
            GPU <span className="text-red-600">Drivers</span>
          </h1>
          <p className="text-zinc-400 text-lg">
            Force reinstall drivers and run comprehensive Windows updates
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Force Reinstall Driver Card */}
          <div className="bg-zinc-900 border-2 border-zinc-800 rounded-lg p-6 hover:border-red-600 transition-all duration-300 shadow-lg hover:shadow-red-600/20">
            <div className="flex items-start gap-4 mb-4">
              <div className="p-3 bg-red-600/10 rounded-lg border border-red-600/30">
                <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-white mb-2">Force Reinstall Driver</h2>
                <p className="text-zinc-400 text-sm leading-relaxed">
                  Completely reinstall your NVIDIA GPU driver using <span className="text-red-500 font-mono">winget --force</span>. 
                  Bypasses version checks and fixes corrupted installations.
                </p>
              </div>
            </div>

            <div className="space-y-3 mb-6 text-sm text-zinc-500">
              <div className="flex items-center gap-2">
                <span className="text-red-600">•</span>
                <span>Tries <code className="text-red-500 bg-black/50 px-1 rounded">NVIDIA.NVIDIA_Display_Driver</code> first</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-red-600">•</span>
                <span>Falls back to <code className="text-red-500 bg-black/50 px-1 rounded">GeForceGameReadyDriver</code></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-red-600">•</span>
                <span>Auto-installs winget if missing</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-red-600">•</span>
                <span>Live progress with ETA tracking</span>
              </div>
            </div>

            <button
              onClick={handleForceReinstall}
              disabled={isReinstalling || isUpdating}
              className="w-full px-6 py-3.5 bg-gradient-to-r from-red-600 to-red-700 text-white font-semibold rounded-lg hover:from-red-700 hover:to-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-red-600/30 hover:shadow-red-600/50 disabled:shadow-none border border-red-500/30"
            >
              {isReinstalling ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Reinstalling Driver...
                </span>
              ) : (
                'Force Reinstall Driver'
              )}
            </button>

            {isReinstalling && activeOperation === 'driver' && (
              <div className="mt-4 space-y-2">
                <div className="bg-zinc-800 rounded-full h-2 overflow-hidden border border-zinc-700">
                  <div
                    className="bg-gradient-to-r from-red-600 to-red-500 h-full transition-all duration-500"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
                <p className="text-xs text-zinc-400 text-center font-mono">{statusMessage}</p>
              </div>
            )}
          </div>

          {/* Run All Windows Updates Card */}
          <div className="bg-zinc-900 border-2 border-zinc-800 rounded-lg p-6 hover:border-red-600 transition-all duration-300 shadow-lg hover:shadow-red-600/20">
            <div className="flex items-start gap-4 mb-4">
              <div className="p-3 bg-red-600/10 rounded-lg border border-red-600/30">
                <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-white mb-2">Run All Windows Updates</h2>
                <p className="text-zinc-400 text-sm leading-relaxed">
                  Three-tier comprehensive update system that tries multiple methods to ensure nothing is missed.
                </p>
              </div>
            </div>

            <div className="space-y-3 mb-6 text-sm text-zinc-500">
              <div className="flex items-start gap-2">
                <span className="text-red-600 mt-0.5">1.</span>
                <span><strong className="text-zinc-300">PSWindowsUpdate</strong> — PowerShell module for full scan + install</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-600 mt-0.5">2.</span>
                <span><strong className="text-zinc-300">COM API</strong> — Microsoft.Update.Session fallback</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-600 mt-0.5">3.</span>
                <span><strong className="text-zinc-300">wuauclt</strong> — Legacy trigger as last resort</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-red-600">•</span>
                <span>Shows live step-by-step progress</span>
              </div>
            </div>

            <button
              onClick={handleRunAllUpdates}
              disabled={isReinstalling || isUpdating}
              className="w-full px-6 py-3.5 bg-gradient-to-r from-red-600 to-red-700 text-white font-semibold rounded-lg hover:from-red-700 hover:to-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-red-600/30 hover:shadow-red-600/50 disabled:shadow-none border border-red-500/30"
            >
              {isUpdating ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Running Updates...
                </span>
              ) : (
                'Run All Windows Updates'
              )}
            </button>

            {isUpdating && activeOperation === 'windows' && (
              <div className="mt-4 space-y-2">
                <div className="bg-zinc-800 rounded-full h-2 overflow-hidden border border-zinc-700">
                  <div
                    className="bg-gradient-to-r from-red-600 to-red-500 h-full transition-all duration-500"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
                <p className="text-xs text-zinc-400 text-center font-mono">{statusMessage}</p>
              </div>
            )}
          </div>
        </div>

        {/* Info Banner */}
        <div className="mt-8 bg-zinc-900 border-l-4 border-red-600 p-4 rounded">
          <div className="flex items-start gap-3">
            <svg className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div>
              <h3 className="text-white font-semibold mb-1">Important Notes</h3>
              <ul className="text-sm text-zinc-400 space-y-1">
                <li>• Both operations require administrator privileges</li>
                <li>• Driver reinstall may take 3-5 minutes depending on your internet speed</li>
                <li>• Windows updates can take 10-30 minutes for multiple updates</li>
                <li>• You may need to restart your PC after completion</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
