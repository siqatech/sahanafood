# Criterios comunes de salida (toda fase)
1. CI verde: lint, types, dependency-cruiser, unit, integración, aislamiento de tenant, SCA.
2. Cobertura de dominio (@sahana/domain) ≥ 90%; Money y totales 100% de ramas.
3. Cero deuda en dinero/tenancy/auditoría; deuda restante registrada en docs/23 con fecha.
4. Specs actualizadas si la implementación divergió (la spec manda; divergencia sin actualizar = bloqueo).
5. docs/progress.md actualizado; demo grabable del alcance de la fase.
6. Checklist OWASP de la fase completado; sin vulnerabilidad alta abierta.
7. Aprobación explícita del propietario del producto para pasar a la siguiente.
