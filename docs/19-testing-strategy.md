# Estrategia de pruebas

| Nivel | Alcance | Herramienta | Gate |
|---|---|---|---|
| Unitarias dominio | `@sahana/domain`: Money, totales, IGV, máquina de estados, recetas | vitest, property-based para Money | 100% de ramas en Money y totales |
| Integración | módulo + Postgres real + Redis | testcontainers | por PR |
| **Aislamiento tenant** | cada endpoint, fixture 2 tenants | suite dedicada | bloqueante por PR |
| Contrato | API vs `packages/contracts`; eventos vs catálogo docs/12 | generación de tipos + tests | por PR |
| E2E | flujos de specs/phases (pedido→cocina→pago→doc) | Playwright | gate de fase |
| Offline | PWA: vender sin red, sync, conflictos RN-T07, reconexión | Playwright + service worker mocks | gate F4 |
| Carga | perfiles docs/06 contra simulador | k6 | gate F4/F5/F7 |
| Seguridad | OWASP checklist, deps, secretos; pentest externo pre-GA | ZAP + SCA + manual | gate de fase |
| Caos controlado | matar worker con cola llena, caída de Redis, latencia BD | scripts | pre-GA |

Datos de prueba: generador de tenants sintéticos (marcas, catálogos, pedidos). Prohibido copiar datos reales fuera de prod; anonimización si se necesita un caso.
