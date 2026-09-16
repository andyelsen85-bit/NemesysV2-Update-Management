aria-label={`Remove ${user.username}`} onClick={() => void remove(user)} className="rounded-md p-2 text-[#9b7972] hover:bg-[#f9e3df] hover:text-[#a13a31]"><Trash2 size={14} /></button></div>)}</div>}</section>
    </div>
  </div>;
}

function SecurityPage() {
  const [ldap, setLdap] = useState<LdapSettings>({ enabled: false, url: '', bindDn: '', bindPasswordSet: false, baseDn: '', computerBaseDn: '', directoryAutoSyncEnabled: false, directorySyncIntervalMinutes: 60, userFilter: '(&(objectClass=person)(sAMAccountName={{username}}))', usernameAttribute: 'sAMAccountName', displayNameAttribute: 'displayName', emailAttribute: 'mail', verifyTlsCertificate: true, caCertificateInstalled: false });
  const [ldapPassword, setLdapPassword] = useState('');
  const [ldapTest, setLdapTest] = useState({ username: '', password: '' });
  const [ssl, setSsl] = useState<SslSettings>({ certificateInstalled: false, privateKeyInstalled: false, chainInstalled: false, certificateFingerprint: null, certificateSubject: null, certificateExpiresAt: null, forceHttps: false, hstsEnabled: false });
  const [certificatePem, setCertificatePem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [chainPem, setChainPem] = useState('');
  const [feedback, setFeedback] = useState('');
  const [syncFeedback, setSyncFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  const statusQuery = useGetLdapDirectoryCacheStatus();
  const groupsQuery = useListLdapDirectoryGroups();
  const computersQuery = useListLdapDirectoryComputers();
  const syncMutation = useSyncLdapDirectory();

  const activeGroupCount = (groupsQuery.data ?? []).filter((g: DirectoryGroup) => g.active).length;
  const computers = computersQuery.data ?? [];
  const enabledComputerCount = computers.filter((c: DirectoryComputer) => c.enabled).length;
  const disabledComputerCount = computers.length - enabledComputerCount;

  useEffect(() => {
    Promise.all([fetch('/api/settings/ldap', { credentials: 'include' }).then((response) => response.json()), fetch('/api/settings/ssl', { credentials: 'include' }).then((response) => response.json())]).then(([ldapBody, sslBody]) => { setLdap(ldapBody as LdapSettings); setSsl(sslBody as SslSettings); }).catch(() => setFeedback('Unable to load security settings.'));
  }, []);
  const updateLdap = <K extends keyof LdapSettings>(key: K, value: LdapSettings[K]) => setLdap((current) => ({ ...current, [key]: value }));
  const readPem = (setter: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void file.text().then(setter); };
  const saveLdap = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFeedback('');
    try {
      const response = await fetch('/api/settings/ldap', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ enabled: ldap.enabled, url: ldap.url, bindDn: ldap.bindDn, bindPassword: ldapPassword || undefined, baseDn: ldap.baseDn, computerBaseDn: ldap.computerBaseDn, directoryAutoSyncEnabled: ldap.directoryAutoSyncEnabled, directorySyncIntervalMinutes: Number(ldap.directorySyncIntervalMinutes), userFilter: ldap.userFilter, usernameAttribute: ldap.usernameAttribute, displayNameAttribute: ldap.displayNameAttribute, emailAttribute: ldap.emailAttribute, verifyTlsCertificate: ldap.verifyTlsCertificate }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Unable to save LDAP settings.'); setLdap(body as LdapSettings); setLdapPassword(''); setFeedback('LDAP settings saved.');
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Unable to save LDAP settings.'); } finally { setBusy(false); }
  };
  const testLdap = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const response = await fetch('/api/settings/ldap/test', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(ldapTest) }); const body = await response.json(); setFeedback(body.success ? body.message : `${body.stage}: ${body.message}`); } catch { setFeedback('LDAP diagnostic failed.'); } finally { setBusy(false); }
  };
  const saveSsl = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFeedback('');
    try {
      const response = await fetch('/api/settings/ssl', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ certificatePem, privateKeyPem, chainPem, forceHttps: ssl.forceHttps, hstsEnabled: ssl.hstsEnabled }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Unable to save SSL settings.'); setSsl(body as SslSettings); setCertificatePem(''); setPrivateKeyPem(''); setChainPem(''); setFeedback('PKI certificate saved. HTTPS activation will be applied by the server runtime or reverse proxy.');
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Unable to save SSL settings.'); } finally { setBusy(false); }
  };
  const handleSyncLdap = () => {
    setSyncFeedback('');
    syncMutation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetLdapDirectoryCacheStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListLdapDirectoryGroupsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListLdapDirectoryComputersQueryKey() });
        setSyncFeedback('Directory cache synchronized.');
      },
      onError: (error) => {
        setSyncFeedback(error instanceof Error ? error.message : 'Synchronization failed.');
      }
    });
  };
  return <div className="mx-auto max-w-[1080px]"><PageHeader eyebrow="Trust and identity" title="Security" detail="Connect administrator access to LDAP and activate HTTPS with your organization’s PKI certificate." />{feedback && <div role="status" className="mb-5 rounded-lg border border-[#b9d8c5] bg-[#e6f4eb] px-4 py-3 text-xs font-semibold text-[#317357]">{feedback}</div>}<div className="grid gap-6 lg:grid-cols-2">
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]"><Users size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">LDAP directory</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">The bind password is encrypted before it is stored in PostgreSQL.</p></div></div><form onSubmit={saveLdap} className="space-y-3"><SettingToggle label="Enable LDAP administrators" detail="Added users authenticate against this directory." value={ldap.enabled} onChange={(value) => updateLdap('enabled', value)} testId="toggle-ldap-enabled" /><label className="block"><span className="field-label">LDAP URL</span><input required value={ldap.url} onChange={(event) => updateLdap('url', event.target.value)} placeholder="ldaps://directory.example.com:636" className="field-input font-mono" /></label><label className="block"><span className="field-label">Service bind DN</span><input value={ldap.bindDn} onChange={(event) => updateLdap('bindDn', event.target.value)} placeholder="CN=svc-nemesys,OU=Service Accounts,DC=example,DC=local" className="field-input font-mono" /></label><label className="block"><span className="field-label">Service bind password {ldap.bindPasswordSet && <span className="font-normal normal-case text-[#4d9475]">(saved)</span>}</span><input type="password" value={ldapPassword} onChange={(event) => setLdapPassword(event.target.value)} placeholder={ldap.bindPasswordSet ? 'Leave blank to keep saved password' : 'Required for directory search'} className="field-input" /></label><label className="block"><span className="field-label">Base DN</span><input required value={ldap.baseDn} onChange={(event) => updateLdap('baseDn', event.target.value)} placeholder="DC=example,DC=local" className="field-input font-mono" /></label><label className="block"><span className="field-label">Computer Base OU DN</span><input value={ldap.computerBaseDn} onChange={(event) => updateLdap('computerBaseDn', event.target.value)} placeholder="OU=Workstations,DC=example,DC=local" className="field-input font-mono" /><span className="mt-1 block text-[10px] text-[#87958e]">Only computer objects under this OU are cached for targeting.</span></label><label className="block"><span className="field-label">User filter</span><input required value={ldap.userFilter} onChange={(event) => updateLdap('userFilter', event.target.value)} className="field-input font-mono" /></label><div className="grid gap-3 sm:grid-cols-3"><label><span className="field-label">Username attr.</span><input value={ldap.usernameAttribute} onChange={(event) => updateLdap('usernameAttribute', event.target.value)} className="field-input font-mono" /></label><label><span className="field-label">Display attr.</span><input value={ldap.displayNameAttribute} onChange={(event) => updateLdap('displayNameAttribute', event.target.value)} className="field-input font-mono" /></label><label><span className="field-label">Email attr.</span><input value={ldap.emailAttribute} onChange={(event) => updateLdap('emailAttribute', event.target.value)} className="field-input font-mono" /></label></div><SettingToggle label="Verify TLS certificate" detail="Recommended for LDAPS and organization CAs." value={ldap.verifyTlsCertificate} onChange={(value) => updateLdap('verifyTlsCertificate', value)} testId="toggle-ldap-tls" />
      <div className="mt-4 rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3 space-y-3">
        <SettingToggle label="Enable directory auto-sync" detail="Periodically synchronize groups and computers." value={ldap.directoryAutoSyncEnabled} onChange={(value) => updateLdap('directoryAutoSyncEnabled', value)} testId="toggle-auto-sync" />
        <label className="block"><span className="field-label">Sync frequency (minutes)</span><input type="number" min="1" max="1440" required value={ldap.directorySyncIntervalMinutes} onChange={(event) => updateLdap('directorySyncIntervalMinutes', Number(event.target.value))} className="field-input font-mono" /></label>
      </div>
      <Button type="submit" disabled={busy}><Save size={14} />Save LDAP settings</Button></form><form onSubmit={testLdap} className="mt-5 space-y-3 border-t border-[#e7ece7] pt-4"><div className="text-xs font-extrabold text-[#38534a]">Connection diagnostic</div><div className="grid gap-3 sm:grid-cols-2"><input required placeholder="Test username" value={ldapTest.username} onChange={(event) => setLdapTest((current) => ({ ...current, username: event.target.value }))} className="field-input" /><input required type="password" placeholder="Test password" value={ldapTest.password} onChange={(event) => setLdapTest((current) => ({ ...current, password: event.target.value }))} className="field-input" /></div><Button type="submit" variant="secondary" disabled={busy}>Test LDAP connection</Button></form></section>
    </div>
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dfeef1] text-[#286b76]"><Server size={18} /></div>
          <div><h2 className="text-sm font-extrabold text-[#284139]">Directory cache</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">Clients and policy editing use the cache only; there are no live LDAP queries during operation.</p></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 mb-4">
          <div className="rounded-lg bg-[#f5f8f3] p-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#87958e]">Cached active groups</div>
            <div className="mt-2 font-mono text-xl font-bold text-[#39514d]">{activeGroupCount}</div>
          </div>
          <div className="rounded-lg bg-[#f5f8f3] p-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#87958e]">Cached computers</div>
            <div className="mt-2 font-mono text-xl font-bold text-[#39514d]">{enabledComputerCount} <span className="text-sm font-normal text-[#87958e]">enabled</span></div>
            <div className="mt-1 text-[10px] text-[#87958e]">{disabledComputerCount} disabled</div>
          </div>
        </div>
        <div className="space-y-2 mb-4 text-xs">
          <div className="flex justify-between border-b border-[#edf0eb] pb-2"><span className="font-bold text-[#536b68]">Last successful sync</span><span className="font-mono text-[#39514d]">{formatTime(statusQuery.data?.lastSuccessfulSyncAt)}</span></div>
          <div className="flex justify-between border-b border-[#edf0eb] pb-2"><span className="font-bold text-[#536b68]">Last attempt</span><span className="font-mono text-[#39514d]">{formatTime(statusQuery.data?.lastAttemptAt)}</span></div>
          {statusQuery.data?.lastError && <div className="rounded bg-[#fff0d5] p-2 text-[11px] text-[#8a5a08]">{statusQuery.data.lastError}</div>}
        </div>
        {syncFeedback && <div className="mb-4 rounded-lg bg-[#e6f4eb] px-3 py-2 text-xs font-semibold text-[#317357]">{syncFeedback}</div>}
        <Button onClick={handleSyncLdap} disabled={syncMutation.isPending}><RefreshCw size={14} className={syncMutation.isPending ? 'animate-spin' : ''} /> {syncMutation.isPending ? 'Synchronizing...' : 'Sync Active Directory'}</Button>
      </section>
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dfeef1] text-[#286b76]"><ShieldCheck size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Organization PKI / HTTPS</h2><p className="mt-1 text-xs leading-5 text-[#87958e]">PEM material is validated, matched, and encrypted at rest for Kubernetes-safe persistence.</p></div></div><form onSubmit={saveSsl} className="space-y-3"><label className="block"><span className="field-label">Certificate PEM</span><textarea required={ !ssl.certificateInstalled } value={certificatePem} onChange={(event) => setCertificatePem(event.target.value)} placeholder={ssl.certificateInstalled ? 'Leave blank to keep the installed certificate' : '-----BEGIN CERTIFICATE-----'} className="field-input min-h-28 font-mono text-[10px]" /><input type="file" accept=".pem,.crt,.cer" onChange={readPem(setCertificatePem)} className="mt-2 block w-full text-[10px] text-[#71817c]" /></label><label className="block"><span className="field-label">Private key PEM</span><textarea required={!ssl.privateKeyInstalled} value={privateKeyPem} onChange={(event) => setPrivateKeyPem(event.target.value)} placeholder={ssl.privateKeyInstalled ? 'Leave blank to keep the installed private key' : '-----BEGIN PRIVATE KEY-----'} className="field-input min-h-28 font-mono text-[10px]" /><input type="file" accept=".pem,.key" onChange={readPem(setPrivateKeyPem)} className="mt-2 block w-full text-[10px] text-[#71817c]" /></label><label className="block"><span className="field-label">Certificate chain PEM <span className="font-normal normal-case">(optional)</span></span><textarea value={chainPem} onChange={(event) => setChainPem(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="field-input min-h-20 font-mono text-[10px]" /><input type="file" accept=".pem,.crt,.cer" onChange={readPem(setChainPem)} className="mt-2 block w-full text-[10px] text-[#71817c]" /></label><div className="rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3 text-xs text-[#536b68]"><div className="flex items-center justify-between"><span>Certificate</span><StatusPill value={ssl.certificateInstalled ? 'installed' : 'missing'} kind={ssl.certificateInstalled ? 'success' : 'warning'} /></div>{ssl.certificateSubject && <div className="mt-2 truncate font-mono text-[10px]">{ssl.certificateSubject}</div>}{ssl.certificateExpiresAt && <div className="mt-1 font-mono text-[10px]">Expires {formatTime(ssl.certificateExpiresAt)}</div>}</div><SettingToggle label="Activate HTTPS" detail="Serve the API over the uploaded certificate and redirect HTTP requests." value={ssl.forceHttps} onChange={(value) => setSsl((current) => ({ ...current, forceHttps: value }))} testId="toggle-force-https" /><SettingToggle label="Enable HSTS" detail="Only enable after HTTPS is confirmed reachable." value={ssl.hstsEnabled} onChange={(value) => setSsl((current) => ({ ...current, hstsEnabled: value }))} testId="toggle-hsts" /><Button type="submit" disabled={busy}><Upload size={14} />Save certificate settings</Button></form></section>
    </div>
  </div></div>;
}

function ApiKeyPage() {
  const settings = useGetServerSettings();
  const current = useGetClientApiKey();
  const rotate = useRotateClientApiKey();
  const reveal = useRevealClientApiKey();
  const audits = useListClientApiKeyRevealAudits();

  const [customKey, setCustomKey] = useState('');
  const [result, setResult] = useState<ApiKeyRotation | null>(null);
  const [revealed, setRevealed] = useState<ApiKeyReveal | null>(null);
  const [feedback, setFeedback] = useState('');

  const configuredKey = current.data;
  const auditList = listData<ApiKeyRevealAudit>(audits.data, 'audit entries');

  const refreshAudits = () => {
    queryClient.invalidateQueries({ queryKey: getListClientApiKeyRevealAuditsQueryKey() });
  };

  const saveCustom = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback('');
    try {
      const response = await fetch('/api/settings/api-key', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ apiKey: customKey }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Unable to save API key.');
      setResult(body as ApiKeyRotation);
      setCustomKey('');
      setRevealed(null);
      reveal.reset();
      setFeedback('The saved key is shown below and will remain available to authenticated administrators.');
      queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/api-key'] });
      refreshAudits();
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Unable to save API key.'); }
  };

  const generate = () => {
    setFeedback('');
    rotate.mutate(undefined, {
      onSuccess: (body) => {
        setResult(body);
        setRevealed(null);
        reveal.reset();
        setFeedback('A new key was generated intentionally. Copy it now for client reconfiguration.');
        queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ['/api/settings/api-key'] });
        refreshAudits();
      },
      onError: (error) => setFeedback(error instanceof Error ? error.message : 'Unable to generate API key.')
    });
  };

  const showKey = () => {
    setFeedback('');
    reveal.mutate(undefined, {
      onSuccess: (body) => {
        setRevealed(body);
        setResult(null);
        refreshAudits();
      },
      onError: (error) => setFeedback(error instanceof Error ? error.message : 'Unable to reveal API key.')
    });
  };

  const hideKey = () => {
    setRevealed(null);
    reveal.reset();
  };

  return <div className="mx-auto max-w-[900px]">
    <PageHeader eyebrow="Client transport" title="Client API key" detail="Manage the shared key used by Windows services. Existing clients continue working until you intentionally replace the key." />

    <div className="grid gap-6 md:grid-cols-2">
      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]">
            <LockKeyhole size={18} />
          </div>
          <div>
            <h2 className="text-sm font-extrabold text-[#284139]">Current key</h2>
            <p className="mt-1 text-xs leading-5 text-[#87958e]">{settings.data?.apiKeyConfigured ? `Configured · last changed ${formatTime(settings.data.apiKeyLastRotatedAt)}` : 'No shared key has been configured.'}</p>
          </div>
        </div>

        {configuredKey?.configured ? (
          <div className="rounded-lg border border-[#b9d8c5] bg-[#f1faf3] p-3">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#317357]">Configured key</div>
              {configuredKey.recoverable && (
                <div className="flex items-center gap-2">
                  {revealed ? (
                    <Button type="button" variant="ghost" onClick={hideKey} className="h-7 px-2 text-[10px] text-[#28745b] hover:bg-[#d4eadd] hover:text-[#1c5542]"><EyeOff size={13} /> Hide</Button>
                  ) : (
                    <Button type="button" variant="ghost" onClick={showKey} disabled={reveal.isPending} className="h-7 px-2 text-[10px] text-[#28745b] hover:bg-[#d4eadd] hover:text-[#1c5542]"><Eye size={13} /> {reveal.isPending ? 'Revealing...' : 'Show API key'}</Button>
                  )}
                </div>
              )}
            </div>

            <code data-testid="text-configured-api-key" className="mt-2 block break-all font-mono text-xs text-[#284139]">
              {revealed ? revealed.apiKey : (configuredKey.maskedApiKey || '****************')}
            </code>

            {revealed && (
              <Button type="button" variant="secondary" className="mt-3" onClick={() => { void navigator.clipboard?.writeText(revealed.apiKey); }}>
                <Copy size={14} /> Copy full key
              </Button>
            )}
          </div>
        ) : null}

        {configuredKey?.configured && !configuredKey.recoverable && (
          <div className="mt-3 rounded-lg border border-[#e4c6b6] bg-[#fff5ee] p-3 text-xs leading-5 text-[#8f5d4e]">
            This key was saved before encrypted key recovery was enabled. It cannot be read back from its hash. Use “Save chosen key” to preserve the key you already have, or generate a replacement.
          </div>
        )}

        <Button type="button" className="mt-4" onClick={generate} disabled={rotate.isPending}>
          <RotateCcw size={14} />
          {rotate.isPending ? 'Generating…' : 'Generate new key'}
        </Button>
        <p className="mt-3 text-[11px] leading-5 text-[#71817c]">Generating or saving a key replaces the current key immediately, so older clients must be reconfigured with the returned value.</p>
      </section>

      <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]">
        <h2 className="text-sm font-extrabold text-[#284139]">Save an existing/custom key</h2>
        <p className="mt-1 text-xs leading-5 text-[#87958e]">Use this to preserve a chosen key during migration. It will be encrypted for future display while the server continues authenticating with its hash.</p>
        <form onSubmit={saveCustom} className="mt-4 space-y-3">
          <input required minLength={16} maxLength={256} type="password" value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="At least 16 characters" className="field-input font-mono" />
          <Button type="submit" variant="secondary">Save chosen key</Button>
        </form>
      </section>
    </div>

    {result && (
      <section className="mt-6 rounded-xl border border-[#e4c6b6] bg-[#fff5ee] p-5">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#a45d3e]">Full key — copy now</div>
        <code data-testid="text-full-api-key" className="mt-2 block break-all rounded-md bg-[#fffdf8] p-3 font-mono text-xs text-[#586c6d]">{result.apiKey}</code>
        <Button type="button" variant="secondary" className="mt-3" onClick={() => { void navigator.clipboard?.writeText(result.apiKey); }}>
          <Copy size={14} /> Copy key
        </Button>
      </section>
    )}

    {feedback && (
      <div role="status" className="mt-4 rounded-lg bg-[#e6f4eb] px-3 py-2 text-xs font-semibold text-[#317357]">{feedback}</div>
    )}

    <section className="mt-6 overflow-hidden rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]">
      <div className="border-b border-[#e5ebe5] px-5 py-4">
        <h2 className="text-sm font-extrabold text-[#284139]">Plaintext disclosure audit</h2>
        <p className="mt-1 text-xs text-[#87958e]">Every display of the plaintext API key is recorded. This audit history cannot be deleted from the console.</p>
      </div>
      {audits.isLoading ? (
        <div className="p-5"><LoadingRows count={3} /></div>
      ) : audits.isError ? (
        <div className="p-5"><ErrorState onRetry={() => audits.refetch()} /></div>
      ) : auditList.length === 0 ? (
        <div className="p-5"><EmptyState icon={Archive} title="No disclosures" detail="The API key has not been revealed." /></div>
      ) : (
        <div className="divide-y divide-[#edf0eb]">
          {auditList.map((audit) => (
            <div key={audit.id} className="flex items-center justify-between px-5 py-3 transition-colors hover:bg-[#fafbf7]">
              <div className="flex items-center gap-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#e3eae7] text-xs font-extrabold text-[#47615c]">
                  {initials(audit.username)}
                </div>
                <div>
                  <div className="text-xs font-bold text-[#365049]">{audit.username}</div>
                  <div className="mt-0.5 text-[10px] text-[#8a9891]">Administrator</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Clock3 size={13} className="text-[#a9b5b0]" />
                <span className="font-mono text-[10px] text-[#71817c]">{formatTime(audit.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  </div>;
}

function ClientUpdatesPage() {
  const clientsQuery = useListClients();
  const settingsQuery = useGetServerSettings();
  const clientList = listData<Client>(clientsQuery.data, 'clients');
  const desiredVersion = settingsQuery.data?.desiredClientVersion;
  const desiredParsed = useMemo(() => parseVersion(desiredVersion), [desiredVersion]);

  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('hostname');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const enrichedClients = useMemo(() => {
    return clientList.map(client => {
      const installedParsed = parseVersion(client.installedVersion);
      const status = compareVersions(installedParsed, desiredParsed);
      return { ...client, statusLabel: status };
    });
  }, [clientList, desiredParsed]);

  const sortedClients = useMemo(() => {
    return [...enrichedClients].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'hostname') cmp = a.hostname.localeCompare(b.hostname);
      if (sortField === 'installedVersion') cmp = compareVersionValues(a.installedVersion, b.installedVersion);
      if (sortField === 'statusLabel') {
        const order = { ahead: 4, current: 3, outdated: 2, unknown: 1 };
        cmp = order[a.statusLabel] - order[b.statusLabel];
      }
      if (cmp === 0) cmp = a.id.localeCompare(b.id);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [enrichedClients, sortField, sortDir]);

  const filtered = sortedClients.filter((client) => {
    const searchStr = `${Object.values(client).join(' ')} ${client.installedVersion || 'unknown'} ${client.statusLabel} ${desiredVersion}`.toLowerCase();
    return searchStr.includes(search.toLowerCase());
  });

  const chartData = useMemo(() => {
    const map = new Map<string, number>();
    let unknownCount = 0;
    for (const client of clientList) {
      if (!client.installedVersion || !isDottedNumericVersion(client.installedVersion)) {
        unknownCount++;
      } else {
        map.set(client.installedVersion, (map.get(client.installedVersion) || 0) + 1);
      }
    }
    const otherColors = ['#417f80', '#cf8d3e', '#6d7894', '#aa695d', '#79966d', '#9978a2'];
    let colorIndex = 0;

    const data = Array.from(map.entries()).map(([name, value]) => {
      let fill = '#2b8a63';
      if (name !== desiredVersion) {
        fill = otherColors[colorIndex % otherColors.length];
        colorIndex++;
      }
      return { name, value, fill };
    });

    if (unknownCount > 0) {
      data.push({ name: 'Unknown', value: unknownCount, fill: '#9aa7a0' });
    }
    // Sort descending by value
    data.sort((a, b) => b.value - a.value);
    return data;
  }, [clientList, desiredVersion]);

  const chartConfig = {
    value: { label: "Clients" },
  };

  const outdatedCount = enrichedClients.filter(c => c.statusLabel === 'outdated').length;
  const currentCount = enrichedClients.filter(c => c.statusLabel === 'current').length;
  const unknownCount = enrichedClients.filter(c => c.statusLabel === 'unknown').length;
  const anyLoading = clientsQuery.isLoading || settingsQuery.isLoading;

  return <div className="mx-auto max-w-[1380px]">
    <PageHeader eyebrow="Fleet version control" title="Client updates" detail="Compare installed NemesysV2 client versions against the desired baseline. Client deployment remains managed through SCCM." action={<Button onClick={() => { clientsQuery.refetch(); settingsQuery.refetch(); }} variant="secondary" disabled={anyLoading}><RefreshCw size={14} className={anyLoading ? 'animate-spin' : ''} /> Refresh</Button>} />
    {clientsQuery.isError || settingsQuery.isError ? <ErrorState onRetry={() => { clientsQuery.refetch(); settingsQuery.refetch(); }} /> : anyLoading ? <LoadingRows count={6} /> : <>
      <div className="mb-6 grid gap-6 md:grid-cols-[1fr_2fr]">
        <div className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]">
          <h2 className="text-sm font-extrabold text-[#284139] mb-4">Version distribution</h2>
          <div className="h-[220px]">
            <ChartContainer config={chartConfig} className="h-full w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={80} paddingAngle={2} stroke="none">
                  {chartData.map((entry) => <Cell key={entry.name} fill={entry.fill} />)}
                </Pie>
              </PieChart>
            </ChartContainer>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-2">{chartData.map((entry) => <div key={entry.name} className="flex items-center gap-1.5 text-[10px] text-[#71817c]"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.fill }} /><span className="font-mono font-bold text-[#486159]">{entry.name}</span><span>{entry.value}</span></div>)}</div>
          <div className="mt-2 text-center text-[11px] font-bold text-[#71817c]">Desired version: <span className="font-mono text-[#2c785b]">{desiredVersion || 'Not set'}</span></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3 content-start">
          <MetricCard label="Current or Ahead" value={currentCount + enrichedClients.filter(c => c.statusLabel === 'ahead').length} detail="matching desired version" icon={CheckCircle2} tone="green" />
          <MetricCard label="Outdated" value={outdatedCount} detail="requiring update" icon={Upload} tone={outdatedCount > 0 ? 'amber' : 'slate'} />
          <MetricCard label="Unknown" value={unknownCount} detail="missing or malformed" icon={CircleHelp} tone="slate" />
        </div>
      </div>
      <div className="mb-4"><div className="relative max-w-sm"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#91a09b]" /><input aria-label="Search client updates" data-testid="input-search-updates" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search hostname or version..." className="h-9 w-full rounded-lg border border-[#d9e1db] bg-[#fbfcf8] pl-9 pr-3 text-xs text-[#284139] outline-none placeholder:text-[#9ba8a1] focus:border-[#75ad95] focus:ring-2 focus:ring-[#4ca27a]/15" /></div></div>
      {filtered.length === 0 ? <EmptyState icon={Laptop} title={search ? "No matching clients" : "No clients enrolled"} detail={search ? "Try a different search term." : "Enroll clients to monitor their versions."} action={search ? <Button variant="secondary" onClick={() => setSearch('')}>Clear search</Button> : undefined} /> : <div className="overflow-x-auto rounded-xl border border-[#dbe3dd] bg-[#fffdf8] shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="hidden min-w-[700px] grid-cols-[1.5fr_1fr_1fr] gap-4 border-b border-[#e5ebe5] bg-[#f8faf6] px-5 py-3 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#87958e] md:grid"><SortHeader label="Client Hostname" field="hostname" sortField={sortField} sortDir={sortDir} onSort={handleSort} /><SortHeader label="Installed Version" field="installedVersion" sortField={sortField} sortDir={sortDir} onSort={handleSort} /><SortHeader label="Status" field="statusLabel" sortField={sortField} sortDir={sortDir} onSort={handleSort} /></div><div className="min-w-[700px] divide-y divide-[#edf0eb]">{filtered.map((client) => <div key={client.id} className="grid gap-3 px-5 py-4 transition-colors hover:bg-[#fafbf7] md:grid-cols-[1.5fr_1fr_1fr] md:items-center md:gap-4"><div className="flex items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#e3f0e9] text-[11px] font-extrabold text-[#2d7258]">{initials(client.hostname)}</div><div className="min-w-0"><div className="truncate text-xs font-extrabold text-[#304b45]">{client.hostname}</div><div className="mt-1 truncate font-mono text-[10px] text-[#899992]">{client.name}</div></div></div><div className="font-mono text-[11px] text-[#536b68]">{client.installedVersion || <span className="text-[#a1b3ac] italic">Unknown</span>}</div><div><StatusPill value={client.statusLabel} kind={client.statusLabel === 'current' || client.statusLabel === 'ahead' ? 'success' : client.statusLabel === 'outdated' ? 'warning' : 'neutral'} /></div></div>)}</div></div>}
    </>}
  </div>;
}

function AdfsSettingsPanel() {
  const query = useGetAdfsSettings();
  const update = useUpdateAdfsSettings();

  const [form, setForm] = useState<AdfsSettingsInput>({});
  const [initialized, setInitialized] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (query.data && !initialized) {
      setForm(query.data);
      setInitialized(true);
    }
  }, [query.data, initialized]);

  const set = <K extends keyof AdfsSettingsInput>(key: K, value: AdfsSettingsInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  const readPem = (setter: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === 'string') setter(text);
    };
    reader.readAsText(file);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    setFeedback('');
    update.mutate({ data: form }, {
      onSuccess: (saved) => {
        setForm(saved);
        setFeedback('AD FS settings saved.');
        queryClient.invalidateQueries({ queryKey: getGetAdfsSettingsQueryKey() });
      },
      onError: (error) => {
         setFeedback(error instanceof Error ? error.message : 'Unable to save AD FS settings.');
      }
    });
  };

  if (query.isError) return <div className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5"><ErrorState onRetry={() => query.refetch()} /></div>;
  if (query.isLoading && !initialized) return <div className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><LoadingRows count={4} /></div>;

  return (
    <form id="adfs-settings-form" onSubmit={save} className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3eaf3] text-[#405e80]"><Globe2 size={18} /></div>
        <div>
          <h2 className="text-sm font-extrabold text-[#284139]">AD FS authentication</h2>
          <p className="mt-1 text-xs leading-5 text-[#87958e]">Configure Active Directory Federation Services or another generic OpenID Connect provider for administrator login.</p>
        </div>
      </div>

      <div className="space-y-4">
        <SettingToggle label="Enable AD FS login" detail="Allow administrators to sign in via the configured provider." value={form.enabled || false} onChange={(value) => set('enabled', value)} testId="toggle-adfs-enabled" />

        <label className="block max-w-sm"><span className="field-label">Display name</span><input required value={form.displayName || ''} onChange={(e) => set('displayName', e.target.value)} placeholder="e.g. AD FS or Azure AD" className="field-input" /></label>
        <label className="block max-w-sm"><span className="field-label">Issuer URL</span><input required value={form.issuer || ''} onChange={(e) => set('issuer', e.target.value)} placeholder="https://adfs.example.com/adfs" className="field-input font-mono" /></label>
        <label className="block max-w-sm"><span className="field-label">Discovery URL <span className="font-normal normal-case">(optional)</span></span><input value={form.discoveryUrl || ''} onChange={(e) => set('discoveryUrl', e.target.value)} placeholder="Uses issuer discovery when blank" className="field-input font-mono" /></label>
        <label className="block max-w-sm"><span className="field-label">Client ID</span><input required value={form.clientId || ''} onChange={(e) => set('clientId', e.target.value)} className="field-input font-mono" /></label>

        <label className="block max-w-sm"><span className="field-label">Client Secret {(query.data?.secretConfigured && !form.clearClientSecret) && <span className="font-normal normal-case text-[#4d9475]">(saved)</span>}</span>
          <input type="password" value={form.clientSecret || ''} onChange={(e) => {
            set('clientSecret', e.target.value);
            if (e.target.value) set('clearClientSecret', false);
          }} placeholder={(query.data?.secretConfigured && !form.clearClientSecret) ? 'Leave blank to keep saved secret' : ''} className="field-input font-mono" />
          {(query.data?.secretConfigured && !form.clearClientSecret && !form.clientSecret) && (
            <button type="button" onClick={() => set('clearClientSecret', true)} className="mt-1 text-[10px] font-semibold text-[#a13a31] hover:underline focus:outline-none">Remove saved secret</button>
          )}
          {form.clearClientSecret && <div className="mt-1 text-[10px] text-[#8a5a08]">Secret will be removed on save.</div>}
          {form.clearClientSecret && query.data?.secretConfigured && <button type="button" onClick={() => set('clearClientSecret', false)} className="mt-1 block text-[10px] font-semibold text-[#317357] hover:underline">Keep existing secret</button>}
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <label><span className="field-label">Username claim</span><input required value={form.usernameClaim || ''} onChange={(e) => set('usernameClaim', e.target.value)} placeholder="upn" className="field-input font-mono" /></label>
          <label><span className="field-label">Email claim</span><input required value={form.emailClaim || ''} onChange={(e) => set('emailClaim', e.target.value)} placeholder="email" className="field-input font-mono" /></label>
          <label><span className="field-label">Display name claim</span><input required value={form.displayNameClaim || ''} onChange={(e) => set('displayNameClaim', e.target.value)} placeholder="name" className="field-input font-mono" /></label>
        </div>

        <label className="block max-w-sm"><span className="field-label">Scopes</span><input required value={form.scopes || ''} onChange={(e) => set('scopes', e.target.value)} placeholder="openid profile email" className="field-input font-mono" /></label>

        <label className="block max-w-sm"><span className="field-label">Redirect URI</span><input required type="url" value={form.redirectUri || ''} onChange={(e) => set('redirectUri', e.target.value)} placeholder="https://updates.example.com/api/auth/adfs/callback" className="field-input font-mono" /><span className="mt-1 block text-[10px] text-[#87958e]">Must exactly match the HTTPS redirect URI registered in AD FS.</span></label>

        <label className="block"><span className="field-label">CA Certificate PEM <span className="font-normal normal-case">(optional)</span> {(query.data?.caConfigured && !form.clearCaCertificate) && <span className="font-normal normal-case text-[#4d9475]">(saved)</span>}</span>
          <textarea value={form.caCertificatePem || ''} onChange={(e) => {
            set('caCertificatePem', e.target.value);
            if (e.target.value) set('clearCaCertificate', false);
          }} placeholder={(query.data?.caConfigured && !form.clearCaCertificate) ? 'Leave blank to keep installed CA certificate' : '-----BEGIN CERTIFICATE-----'} className="field-input min-h-20 font-mono text-[10px]" />
          <input type="file" accept=".pem,.crt,.cer" onChange={readPem((v) => { set('caCertificatePem', v); set('clearCaCertificate', false); })} className="mt-2 block w-full text-[10px] text-[#71817c]" />
          {(query.data?.caConfigured && !form.clearCaCertificate && !form.caCertificatePem) && (
            <button type="button" onClick={() => set('clearCaCertificate', true)} className="mt-1 text-[10px] font-semibold text-[#a13a31] hover:underline focus:outline-none">Remove installed CA certificate</button>
          )}
          {form.clearCaCertificate && <div className="mt-1 text-[10px] text-[#8a5a08]">CA Certificate will be removed on save.</div>}
          {form.clearCaCertificate && query.data?.caConfigured && <button type="button" onClick={() => set('clearCaCertificate', false)} className="mt-1 block text-[10px] font-semibold text-[#317357] hover:underline">Keep existing certificate</button>}
        </label>
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-[#e5ebe5] pt-5">
        <div>
          {feedback && <span className={cx("text-xs font-semibold", feedback.includes('Unable') ? "text-[#a13a31]" : "text-[#317357]")}>{feedback}</span>}
        </div>
        <Button type="submit" disabled={update.isPending}><Save size={14} />{update.isPending ? 'Saving...' : 'Save AD FS settings'}</Button>
      </div>
    </form>
  );
}


function BackupRestorePanel() {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const restoreMutation = useRestoreAdminBackup();
  const [file, setFile] = useState<File | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError('');
    try {
      const backup = await downloadAdminBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nemesys-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Unable to download backup.');
    } finally {
      setDownloading(false);
    }
  };

  const handleRestore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || confirmPhrase !== 'RESTORE NEMESYS') return;

    setRestoreError('');
    setRestoreSuccess(false);

    restoreMutation.mutate({ data: { file: file as unknown as string } }, {
      onSuccess: () => {
        setRestoreSuccess(true);
        queryClient.clear();
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      },
      onError: (err) => {
        setRestoreError(err instanceof Error ? err.message : 'Failed to restore backup.');
      }
    });
  };

  return (
    <section className="mt-6 rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e8ebee] text-[#5b6a74]">
          <HardDrive size={18} />
        </div>
        <div>
          <h2 className="text-sm font-extrabold text-[#284139]">System backup and restore</h2>
          <p className="mt-1 text-xs text-[#87958e]">Download a complete JSON snapshot of all application data, or restore an existing snapshot. Restoring will replace all current data.</p>
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-[#38534a]">Export current state</div>
            <div className="mt-1 text-[10px] text-[#87958e]">Includes clients, policies, audit history, and configuration.</div>
          </div>
          <Button type="button" onClick={handleDownload} disabled={downloading}>
            <HardDrive size={13} /> {downloading ? 'Downloading...' : 'Download backup'}
          </Button>
        </div>
        {downloadError && <div className="mt-2 text-xs font-semibold text-[#a13a31]">{downloadError}</div>}
      </div>

      <div className="rounded-lg border border-[#e7bbb5] bg-[#fff8f6] p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-[#a13a31]">
          <AlertTriangle size={15} /> Restore from backup
        </div>
        <div className="mt-2 text-[11px] leading-5 text-[#9d6a62]">
          <strong>Warning:</strong> This is a destructive operation. All existing clients, policies, configuration, and administrator accounts will be overwritten by the backup contents. All users will be immediately signed out.
        </div>

        <form onSubmit={handleRestore} className="mt-4 space-y-4">
          <label className="block">
            <span className="field-label">Backup file (.json)</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="mt-1 block w-full text-xs text-[#71817c] file:mr-3 file:rounded-md file:border file:border-[#e7bbb5] file:bg-[#f9e3df] file:px-3 file:py-1.5 file:text-[11px] file:font-bold file:text-[#a13a31] hover:file:bg-[#f4d5cf] file:transition-colors file:cursor-pointer"
            />
          </label>

          {file && (
            <label className="block">
              <span className="field-label">Type RESTORE NEMESYS to confirm</span>
              <input
                required
                type="text"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder="RESTORE NEMESYS"
                className="field-input font-mono"
                autoComplete="off"
              />
            </label>
          )}

          {restoreError && <div className="text-xs font-semibold text-[#a13a31]">{restoreError}</div>}

          {restoreSuccess && (
            <div className="flex items-center gap-2 text-xs font-bold text-[#2c8b63]">
              <CheckCircle2 size={15} /> Restore complete. Signing out...
            </div>
          )}

          {file && (
            <Button
              type="submit"
              variant="danger"
              disabled={confirmPhrase !== 'RESTORE NEMESYS' || restoreMutation.isPending || restoreSuccess}
            >
              {restoreMutation.isPending ? 'Restoring...' : 'Replace all data'}
            </Button>
          )}
        </form>
      </div>
    </section>
  );
}

function SettingsPage() {
  const query = useGetServerSettings();
  const update = useUpdateServerSettings();
  const rotate = useRotateClientApiKey();
  type SettingsForm = ServerSettings;
  const [form, setForm] = useState<SettingsForm>({ syncPort: 443, adminHttpsEnabled: true, desiredClientVersion: '1.0.0', apiKeyConfigured: false, apiKeyLastRotatedAt: null });
  const [serverHostname, setServerHostname] = useState(window.location.hostname || 'api.nemesys.local');
  const [rotation, setRotation] = useState<ApiKeyRotation | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => { if (query.data && !initialized) { setForm((current) => ({ ...current, ...query.data })); setInitialized(true); } }, [query.data, initialized]);
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = (event: FormEvent) => { event.preventDefault(); update.mutate({ data: { syncPort: form.syncPort, adminHttpsEnabled: form.adminHttpsEnabled, desiredClientVersion: form.desiredClientVersion } }, { onSuccess: (saved) => { setForm((current) => ({ ...current, ...saved })); setFeedback('Settings saved. Policy settings apply on the next client sync.'); queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() }); } }); };
  const rotateKey = () => { rotate.mutate(undefined, { onSuccess: (result) => { setRotation(result); setFeedback('New API key generated. Use the one-time command below to install or reconfigure clients.'); queryClient.invalidateQueries({ queryKey: getGetServerSettingsQueryKey() }); } }); };
  const serverEndpoint = /^https?:\/\//i.test(serverHostname) ? serverHostname : `https://${serverHostname}`;
  const installCommand = rotation ? `NemesysClientSetup.exe /quiet /server "${serverEndpoint}" /apiKey "${rotation.apiKey}"` : '';
  return <div className="mx-auto max-w-[1080px]">
      <PageHeader eyebrow="Control plane configuration" title="Settings" detail="Manage the shared API-key transport and server endpoint for enrolled Windows clients." action={<AdminPasswordPanel />} />
    {query.isError ? <ErrorState onRetry={() => query.refetch()} /> : query.isLoading && !initialized ? <LoadingRows count={4} /> : <div className="grid gap-6 lg:grid-cols-[1.25fr_.75fr]"><div className="space-y-6">
       <form id="server-settings-form" onSubmit={save} className="space-y-6">
         <section data-testid="panel-api-key-transport" className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3f0e9] text-[#28745b]"><LockKeyhole size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Shared API key transport</h2><p className="mt-1 text-xs text-[#87958e]">Clients identify by hostname and use a shared key. The server keeps a hash for authentication and an encrypted copy for intentional administrator recovery.</p></div></div><div className="flex items-center justify-between rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3"><div><div className="text-xs font-bold text-[#38534a]">Key status</div><div data-testid="status-shared-api-key" className="mt-1 text-[10px] text-[#28745b]">{rotation ? 'New key ready for silent install' : form.apiKeyConfigured ? `Configured · rotated ${formatTime(form.apiKeyLastRotatedAt)}` : 'Not configured'}</div></div><Button type="button" variant="secondary" data-testid="button-rotate-api-key" onClick={rotateKey} disabled={rotate.isPending}><RotateCcw size={13} />{rotate.isPending ? 'Generating…' : 'Rotate key'}</Button></div>{rotation && <div className="mt-4 rounded-lg border border-[#e4c6b6] bg-[#fff5ee] p-3"><div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#a45d3e]">One-time installation command</div><code data-testid="text-silent-install-command" className="mt-2 block break-all rounded-md bg-[#fffdf8] p-2 font-mono text-[11px] leading-5 text-[#586c6d]">{installCommand}</code><Button type="button" variant="secondary" className="mt-3" data-testid="button-copy-install-command" onClick={() => { void navigator.clipboard?.writeText(installCommand); }}>Copy command</Button><div className="mt-2 text-[10px] leading-4 text-[#8f766b]">The API key is returned once. The client installer must encrypt it on the machine; the server hostname remains clear text in the client configuration.</div></div>}</section>
         <section data-testid="panel-server-endpoint" className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#fff0d5] text-[#94661a]"><Globe2 size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Server hostname and endpoint</h2><p className="mt-1 text-xs text-[#87958e]">The hostname is safe to keep in clear text so the Windows service can locate this Kubernetes-hosted control plane.</p></div></div><label className="block max-w-sm"><span className="field-label">Server hostname</span><input data-testid="input-server-hostname" value={serverHostname} onChange={(e) => setServerHostname(e.target.value)} className="field-input font-mono" /></label><div className="mt-4 max-w-sm rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3"><div className="field-label">Client sync connection</div><div className="mt-1 font-mono text-xs font-bold text-[#38534a]">HTTPS · TCP 443</div></div></section>
         <section data-testid="panel-client-version" className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3eaf3] text-[#405e80]"><Upload size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Desired client version</h2><p className="mt-1 text-xs text-[#87958e]">Configure the expected version for the NemesysV2 Windows client. Outdated clients are tracked in the Client updates view.</p></div></div><label className="block max-w-sm"><span className="field-label">Desired version</span><input data-testid="input-desired-client-version" required pattern="^\d+(?:\.\d+)*$" value={form.desiredClientVersion || ''} onChange={(e) => set('desiredClientVersion', e.target.value)} className="field-input font-mono" placeholder="1.0.0" /></label></section>
         <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#dfeef1] text-[#286b76]"><Activity size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Client monitoring cadence</h2><p className="mt-1 text-xs text-[#87958e]">The Windows service checks every 5 minutes normally and every 30 seconds while any enabled application policy is in Update Mode. Random jitter prevents synchronized polling.</p></div></div></section>
         <section className="rounded-xl border border-[#dbe3dd] bg-[#fffdf8] p-5 shadow-[0_4px_18px_rgba(39,66,58,.035)]"><div className="mb-5 flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e3eaf3] text-[#405e80]"><Settings2 size={18} /></div><div><h2 className="text-sm font-extrabold text-[#284139]">Administration channel</h2><p className="mt-1 text-xs text-[#87958e]">Protect the control center session and keep client transport separate.</p></div></div><SettingToggle label="Admin HTTPS" detail="Protect the control center session with HTTPS." value={form.adminHttpsEnabled} onChange={(value) => set('adminHttpsEnabled', value)} testId="toggle-admin-https" /><div className="mt-3 rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3 text-xs"><div className="font-bold text-[#38534a]">Shared API-key client access</div><div className="mt-1 text-[10px] text-[#87958e]">The server stores a SHA-256 hash; clients authenticate with the encrypted local key and hostname identity.</div></div></section>
       </form>

       <AdfsSettingsPanel />
       <BackupRestorePanel />

       </div><div className="space-y-4"><div className="sticky top-[94px] rounded-xl border border-[#dbe3dd] bg-[#203c4a] p-5 text-[#edf5ee] shadow-[0_7px_25px_rgba(29,55,63,.1)]"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8ec5ad]"><ShieldCheck size={14} /> Connection posture</div><div className="mt-4 space-y-3"><div className="flex items-center justify-between border-b border-[#365563] pb-3 text-xs"><span className="text-[#aec3bd]">Server endpoint</span><span data-testid="text-server-endpoint" className="font-mono font-bold text-[#b9e7ca]">{serverHostname}:{form.syncPort}</span></div><div className="flex items-center justify-between border-b border-[#365563] pb-3 text-xs"><span className="text-[#aec3bd]">Client identity</span><span className="font-mono font-bold text-[#b9e7ca]">HOSTNAME</span></div><div className="flex items-center justify-between text-xs"><span className="text-[#aec3bd]">Monitoring cadence</span><span className="font-mono font-bold text-[#b9e7ca]">5m / 30s Update Mode</span></div></div><Button form="server-settings-form" type="submit" disabled={update.isPending} className="mt-6 w-full"><Save size={14} />{update.isPending ? 'Applying changes…' : 'Save server settings'}</Button>{feedback && <div className="mt-3 flex gap-2 rounded-lg bg-[#2b584b] px-3 py-2 text-[11px] leading-4 text-[#bde8cb]"><CheckCircle2 size={14} className="mt-0.5 shrink-0" />{feedback}</div>}</div><div className="rounded-xl border border-[#dbe3dd] bg-[#fbfcf8] p-4"><div className="flex gap-2 text-xs font-bold text-[#486159]"><CircleHelp size={15} className="text-[#5d947b]" /> Configuration status</div><p className="mt-2 text-[11px] leading-5 text-[#84928c]">Hostname is supplied by the administrator, key rotation returns the value once, and all close timeouts and Update Mode actions are configured per software policy.</p></div></div></div>}
  </div>;
}

function SettingToggle({ label, detail, value, onChange, testId }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void; testId: string }) {
  return <div className="flex items-center justify-between gap-4 rounded-lg border border-[#e2e9e2] bg-[#f9fbf7] p-3"><div><div className="text-xs font-bold text-[#38534a]">{label}</div><div className="mt-1 text-[10px] text-[#87958e]">{detail}</div></div><button type="button" role="switch" aria-checked={value} data-testid={testId} onClick={() => onChange(!value)} className={cx('relative h-6 w-11 shrink-0 rounded-full border transition-colors', value ? 'border-[#267154] bg-[#2b8a63]' : 'border-[#aebbb3] bg-[#d2d9d4]')}><span className={cx('absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform', value ? 'translate-x-5' : 'translate-x-0')} /></button></div>;
}

function Router() {
  return <ErrorBoundary resetKey={window.location.pathname}><Layout><Switch><Route path="/" component={OverviewPage} /><Route path="/clients" component={ClientsPage} /><Route path="/client-updates" component={ClientUpdatesPage} /><Route path="/software" component={SoftwarePage} /><Route path="/audit" component={AuditPage} /><Route path="/administrators" component={AdministratorsPage} /><Route path="/security" component={SecurityPage} /><Route path="/api-key" component={ApiKeyPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></Layout></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AuthGate><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></AuthGate></QueryClientProvider>;
}

export default App;