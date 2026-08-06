# ADR-0013 — Representación interna de `Money`: entero a escala 4

| Campo | Valor |
|---|---|
| Estado | **Aceptado** (implementado en `@sahana/domain`, T3.03) |
| Fecha | 6 de agosto de 2026 |
| Depende de | ADR-0006 (stack, `Money` entero), RN-T04, RN-T05 |

## Contexto

CLAUDE.md exige `Money` como "enteros en céntimos" (2 decimales). Pero dos
reglas del negocio piden más precisión:

- **RN-T04:** los subtotales conservan **4 decimales**; el redondeo half-up a 2
  decimales se aplica **solo al total**.
- **Base de datos:** el modelo de datos define montos como `NUMERIC(14,4)`.

"Céntimos" (escala 2) y "subtotales a 4 decimales" están en tensión: si `Money`
guardara solo 2 decimales, prorrateos, porcentajes e IGV acumularían error de
redondeo antes de llegar al total.

## Decisión

`Money` guarda un **entero de unidades menores a escala 4** (diezmilésimos),
coincidente con `NUMERIC(14,4)`. El redondeo half-up a 2 decimales
(`roundToCents`) se aplica explícitamente donde el negocio lo exige: el TOTAL y
el comprobante SUNAT. La aritmética intermedia (descuentos, IGV, reparto)
trabaja a escala 4 y no pierde céntimos.

- `fromMinor` / `parse` construyen sin usar `number` decimal (se evita el error
  de punto flotante desde el origen).
- `roundToCents()` / `toCents()` entregan la vista de 2 decimales para SUNAT.
- `allocate()` reparte sin perder ni inventar céntimos (suma de partes = total).
- El desglose de IGV (`extractInclusiveTax`) deriva el impuesto por resta, de
  modo que `neto + impuesto === bruto` siempre.

## Consecuencias

- **+** Una sola representación, coherente con la BD; sin pérdida de precisión en
  subtotales; el gate de "100% de ramas en dinero" es alcanzable y se cumple.
- **+** El mismo paquete corre idéntico en servidor y POS offline (ADR-0006): un
  total idéntico en ambos lados es la defensa contra comprobantes divergentes.
- **−** "Céntimos" en la prosa del proyecto significa, con precisión, "unidades
  menores a escala 4". Se documenta en el código y aquí para evitar confusión.
- El soporte multi-moneda con distinto número de decimales (p. ej. CLP sin
  decimales) se revisará en F9 (multi-país); hoy PEN/USD usan escala 4 uniforme.
