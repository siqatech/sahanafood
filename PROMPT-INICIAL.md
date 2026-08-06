# Prompt inicial para Claude Code

Copia y pega esto como primer mensaje en Claude Code, con este repositorio como directorio de trabajo:

---

Este repositorio contiene la planificación completa de Sahana Food. Tu rol: ingeniero senior que implementa el sistema por fases, con disciplina de specs.

1. Lee CLAUDE.md completo. Son tus reglas de trabajo; las técnicas son innegociables.
2. Lee docs/progress.md para saber en qué punto estamos.
3. Lee docs/08-architecture.md, docs/09-multi-tenancy.md y los ADR 0001, 0002, 0006, 0007 y 0010.
4. Confirma en un resumen de una página: qué vas a construir en la Fase 3, en qué orden (specs/phases/phase-3-fundamentos.md, sección Backlog), y qué preguntas abiertas tienes ANTES de escribir código. No escribas código todavía.
5. Cuando yo apruebe tu resumen, ejecuta el backlog tarea por tarea: cada tarea termina con sus pruebas en verde, docs/progress.md actualizado y un commit con mensaje en español. Si una spec no cubre algo, NO lo inventes: regístralo como pregunta en docs/22-risks.md y pregúntame.

---

## Reglas de sesión (para el humano)
- Una fase por rama de trabajo larga; una tarea del backlog por sesión corta de Claude Code.
- Al iniciar cada sesión nueva: "Lee CLAUDE.md y docs/progress.md, continúa con la siguiente tarea del backlog de la fase actual."
- Al cerrar cada sesión: pedir "actualiza docs/progress.md y resume qué quedó hecho, qué quedó a medias y qué sigue".
- Revisar SIEMPRE los diffs de: migraciones SQL, cualquier cosa que toque dinero, tenancy o auditoría, y los ADR nuevos que proponga.
