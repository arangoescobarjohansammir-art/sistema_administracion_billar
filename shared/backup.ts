export type BackupStatus = {
  state: 'pending' | 'checking' | 'verified' | 'error' | 'unconfigured';
  copiedAt: string | null;
  verifiedAt: string | null;
  error: string | null;
};

export type CashBackups = { local: BackupStatus; secondary: BackupStatus };
