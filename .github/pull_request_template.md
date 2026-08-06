<!-- Formato de PR (docs/29-coding-conventions.md). Un módulo = una rama = un PR conceptual. -->

## Tarea del backlog
<!-- p.ej. T3.08 · módulo Identity -->

## Qué cambia y por qué
<!-- Resumen de las decisiones tomadas. Enlaza specs/ADR relevantes. -->

## Cómo probar
<!-- Comando(s) o request(s) de ejemplo reproducibles. -->

## Checklist
- [ ] Pruebas nuevas incluidas (unitarias de dominio / integración)
- [ ] **Prueba de aislamiento de tenant** si hay endpoint nuevo (fixture 2 tenants)
- [ ] Migración revisada y compatible hacia atrás (diff SQL leído a mano)
- [ ] Nada que toque **dinero / tenancy / auditoría** sin revisión explícita
- [ ] Dinero solo vía `Money` de `@sahana/domain` (sin `number` monetario)
- [ ] Spec/docs actualizadas si la implementación divergió
- [ ] `docs/progress.md` actualizado
- [ ] Sin TODOs sin issue asociado
- [ ] CI verde (lint · types · fronteras · dominio · integración)
