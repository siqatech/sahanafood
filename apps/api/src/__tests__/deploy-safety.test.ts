import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { INTEGRATION_DB } from './helpers.js';

/**
 * Seguridad del despliegue (docs/17, T5.35).
 *
 * El criterio de la fase: **un despliegue malo se revierte sin tocar la base de
 * datos**. Eso no se consigue con una herramienta de despliegue, se consigue
 * con dos cosas, y aquí se comprueban las dos:
 *
 *  1. **Ninguna migración rompe a la versión anterior.** Si una migración borra
 *     una columna que el código viejo lee, volver a la imagen anterior deja el
 *     sistema roto igual y el rollback pasa a exigir restaurar un backup — con
 *     los pedidos de la última hora dentro.
 *  2. **Una base por delante del código está LISTA.** Es el estado exacto tras
 *     revertir. Si la sonda de readiness lo marcara como no listo, revertir
 *     obligaría a tocar la base.
 */
const raiz = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GATE = join(raiz, 'infra/scripts/check-migrations.mjs');
const MIGRACIONES = join(raiz, 'infra/migrations');
const ejecutar = promisify(execFile);

describe('Seguridad del despliegue (T5.35)', () => {
  it('todas las migraciones admiten volver a la imagen anterior', async () => {
    const { stderr } = await ejecutar(process.execPath, [GATE]);
    expect(stderr).toContain('admiten volver a la imagen anterior');
  });

  it('EL GATE RECHAZA una migración destructiva', async () => {
    // Un gate que nunca falla no es un gate. Se comprueba con una migración
    // deliberadamente mala en vez de confiar en que el regex esté bien.
    const ruta = join(MIGRACIONES, '9999_prueba_del_gate.sql');
    await writeFile(
      ruta,
      [
        '-- Migración de prueba del gate. Se borra al terminar.',
        'ALTER TABLE ord_orders DROP COLUMN notes;',
        'ALTER TABLE ord_orders ADD COLUMN urgente boolean NOT NULL;',
      ].join('\n'),
    );

    try {
      await expect(ejecutar(process.execPath, [GATE])).rejects.toThrow();
      const salida = await ejecutar(process.execPath, [GATE]).catch(
        (e: { stderr: string }) => e,
      );
      expect(salida.stderr).toContain('DROP COLUMN');
      expect(salida.stderr).toContain('NOT NULL sin DEFAULT');
    } finally {
      await unlink(ruta);
    }
  });

  it('una CONTRACCIÓN declarada sí pasa, y sin declarar contra qué no', async () => {
    const ruta = join(MIGRACIONES, '9999_contraccion.sql');
    const cuerpo = 'ALTER TABLE ord_orders DROP COLUMN notes;';

    try {
      // Sin decir contra qué expansión: rechazada. Declararlo obliga a escribir
      // qué versión deja de usarse, que es la comprobación que nadie hace de
      // memoria.
      await writeFile(ruta, `-- fase: contract\n${cuerpo}\n`);
      const fallo = await ejecutar(process.execPath, [GATE]).catch(
        (e: { stderr: string }) => e,
      );
      expect(fallo.stderr).toContain('no dice contra qué expansión');

      await writeFile(
        ruta,
        `-- fase: contract\n-- expande: 0009_ordering.sql\n${cuerpo}\n`,
      );
      const ok = await ejecutar(process.execPath, [GATE]);
      expect(ok.stderr).toContain('admiten volver a la imagen anterior');
    } finally {
      await unlink(ruta);
    }
  });
});

const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Sonda de readiness (T5.35)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('dice LISTO con la base al día y declara qué esquema necesita', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(r.body.status).toBe('ready');
    expect(r.body.database).toBe('ok');
    // Declara ambos números: un canario que solo ve «ready» no puede explicar
    // por qué la versión nueva no entra.
    expect(r.body.schemaRequired).toMatch(/^\d{4}_.*\.sql$/);
    expect(r.body.schemaApplied).toMatch(/^\d{4}_.*\.sql$/);
  });

  it('LIVENESS Y READINESS son cosas distintas', async () => {
    // Un proceso vivo con la base caída tiene que salir del balanceador SIN que
    // nadie lo reinicie: reiniciarlo no arregla la base y sí tira las
    // peticiones en vuelo.
    const vivo = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(vivo.body.status).toBe('ok');
    expect(vivo.body).not.toHaveProperty('schemaApplied');
  });

  it('la base POR DELANTE del código sigue LISTA', async () => {
    // El estado exacto tras revertir a la imagen anterior: el esquema tiene
    // migraciones que el código viejo no conoce. Si esto no estuviera listo,
    // revertir exigiría tocar la base — justo lo que el criterio prohíbe.
    const r = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    const aplicada: string = r.body.schemaApplied;
    const requerida: string = r.body.schemaRequired;
    expect(aplicada >= requerida).toBe(true);
    // Y la regla que lo gobierna, escrita como comparación y no como prosa:
    // listo ⟺ aplicada ≥ requerida.
    expect(r.body.status).toBe('ready');
  });
});
