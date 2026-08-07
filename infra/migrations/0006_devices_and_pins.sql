-- 0006 — Dispositivos POS y PIN de operador (spec 02, RN-IDN-03/04).
--
-- REVISAR SIEMPRE ESTE DIFF: toca autenticación.
--
-- Contexto: el POS es una PWA que corre en una tablet del local, compartida por
-- varios operadores durante el turno. Eso separa dos identidades distintas:
--
--   · El DISPOSITIVO se autentica una vez, al instalarse, con un código de
--     emparejamiento de un solo uso que emite un administrador. A partir de ahí
--     guarda un token propio, revocable desde el panel si la tablet se pierde.
--   · El OPERADOR se identifica con un PIN corto en cada acción sensible
--     (descuentos, anulaciones, apertura de caja). El PIN es corto por
--     necesidad operativa —se teclea decenas de veces por turno— y por eso el
--     bloqueo por intentos es la defensa real, no la longitud.

-- ---------------------------------------------------------------------------
-- Códigos de emparejamiento (RN-IDN-04): un solo uso, con caducidad.
-- Se guarda el HASH del código, nunca el código en claro: si se filtra la
-- tabla, no se puede emparejar un dispositivo con ella.
-- ---------------------------------------------------------------------------
CREATE TABLE idn_pairing_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  location_id uuid,                              -- local al que quedará atado
  created_by  uuid,                              -- usuario admin que lo emitió
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                       -- NULL = sin usar
  device_id   uuid,                              -- dispositivo resultante
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE idn_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_pairing_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_pairing_codes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- El canje busca por hash sin conocer aún el tenant (igual que el login).
CREATE UNIQUE INDEX idx_pairing_code_hash ON idn_pairing_codes (code_hash);
-- Escape SOLO-SELECT para resolver el tenant durante el canje (ver ADR-0014).
CREATE POLICY auth_lookup ON idn_pairing_codes FOR SELECT
  USING (current_setting('app.auth_lookup', true) = 'on');

-- ---------------------------------------------------------------------------
-- Dispositivos POS emparejados
-- ---------------------------------------------------------------------------
CREATE TABLE idn_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  location_id   uuid,
  name          text NOT NULL,
  token_hash    text NOT NULL,                   -- sha256 del token de dispositivo
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked')),
  paired_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE idn_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_devices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE UNIQUE INDEX idx_devices_token_hash ON idn_devices (token_hash);
CREATE INDEX idx_devices_tenant ON idn_devices (tenant_id, status);
-- El dispositivo se autentica sin contexto de tenant previo: mismo escape acotado.
CREATE POLICY auth_lookup ON idn_devices FOR SELECT
  USING (current_setting('app.auth_lookup', true) = 'on');

-- Cerrar el círculo: el código apunta al dispositivo que creó.
ALTER TABLE idn_pairing_codes
  ADD CONSTRAINT fk_pairing_device
  FOREIGN KEY (tenant_id, device_id)
  REFERENCES idn_devices (tenant_id, id) ON DELETE SET NULL;

-- `idn_users` necesita UNIQUE (tenant_id, id) para que la tabla de PIN pueda
-- referenciarlo con FK COMPUESTA (docs/09 §4). Debe existir ANTES de la FK.
ALTER TABLE idn_users ADD CONSTRAINT idn_users_tenant_id_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- PIN de operador (RN-IDN-03)
--
-- `failed_attempts` y `locked_until` viven aquí y NO en memoria: el bloqueo
-- debe sobrevivir al reinicio del proceso y ser el mismo para todas las
-- instancias de la API. Un contador en memoria se reinicia con el despliegue y
-- deja la fuerza bruta abierta.
-- ---------------------------------------------------------------------------
CREATE TABLE idn_user_pins (
  tenant_id       uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  pin_hash        text NOT NULL,                 -- argon2id
  must_change     boolean NOT NULL DEFAULT true, -- cambio obligatorio al 1er uso
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES idn_users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT pin_intentos_no_negativos CHECK (failed_attempts >= 0)
);
ALTER TABLE idn_user_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_user_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_user_pins
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
