# ADR-0004 — Repositorios open source solo como referencia

Estado: Aprobado por el equipo · Fecha: 2026-08-05

## Decisión
Ningún proyecto analizado (Odoo, URY, ERPNext/Frappe, TastyIgniter, Floreant, OSPOS, uniCenta, Medusa, Vendure, etc.) se usa como base de código. Se estudian modelo de dominio, flujos y casos límite. Cada aprendizaje adoptado se documenta en docs/repositories/.

## Consecuencias
+ Sin herencia de licencias, versiones ni modelo de datos ajeno; multi-tenant limpio. − Más esfuerzo de construcción propia (aceptado: es el producto). Ver ADR-0009 para el régimen de licencias.
