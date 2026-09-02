BEGIN;

DELETE FROM public.nemesys_audit_entries
WHERE id IN ('audit-lyon-01', 'audit-nantes-02')
  AND client_id IN ('poste-lyon-01', 'poste-nantes-02');

DELETE FROM public.nemesys_clients
WHERE (id, name, hostname, address, status, sync_version, certificate_status) IN (
  ('poste-lyon-01', 'Poste Lyon 01', 'POSTE-LYON-01', '10.24.8.41', 'online', '2.4.1', 'valid'),
  ('poste-paris-07', 'Poste Paris 07', 'POSTE-PARIS-07', '10.24.8.87', 'stale', '2.4.0', 'expiring'),
  ('poste-nantes-02', 'Poste Nantes 02', 'POSTE-NANTES-02', '10.24.9.12', 'online', '2.4.1', 'valid')
);

DELETE FROM public.nemesys_software_policies
WHERE (id, name, executable, target_version, rule_type, enabled) IN (
  ('pen-soins', 'PEN-SOINS', 'PenSoins.exe', '454', 'ini', true),
  ('dx-launch', 'DX Launch', 'DxLaunch.exe', '9.2021.6.5', 'file-version', true),
  ('med-syst', 'MedSyst', 'MedSyst.exe', '5.5.4.5', 'file-version', false)
);

COMMIT;