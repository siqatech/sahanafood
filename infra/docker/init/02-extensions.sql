-- Extensiones que necesita el esquema, creadas por el SUPERUSUARIO al arrancar.
--
-- No van en una migración por un motivo concreto: `CREATE EXTENSION` exige
-- superusuario, y `sahana_migrator` NO lo es a propósito —es lo que garantiza
-- que las migraciones no puedan saltarse RLS (docs/09)—. Darle superusuario
-- para instalar una extensión convertiría el rol de migraciones en un agujero
-- permanente por una necesidad de un solo día.
--
-- Este archivo lo ejecuta el contenedor de Postgres en su primer arranque, y CI
-- lo corre explícitamente antes de migrar. Así el entorno se levanta de cero
-- sin ningún paso manual, que es la condición para que sea reproducible.

-- pgvector: búsqueda por similitud para el RAG del agente (T5.23, ADR-0011).
CREATE EXTENSION IF NOT EXISTS vector;
