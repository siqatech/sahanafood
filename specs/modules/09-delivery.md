# Módulo: Delivery
> Fase: 4 (zonas/tarifas) / 5–6 (repartidores) 

## Alcance
F4: validación de cobertura y tarifa (usa Organization.zones). F5: repartidores propios, asignación manual→automática, estados, tracking (WS), evidencia (foto/firma), cobro contra entrega. F6: agrupación de pedidos, liquidación de repartidores, incidencias y reintentos.
## Reglas
RN-DLV-01 Asignación automática: zona + carga + antigüedad de promesa; empate → menor carga. RN-DLV-02 Contra entrega genera saldo del repartidor; liquidación al cierre de su turno contra sesión de caja. RN-DLV-03 Entrega fallida → estado + motivo + reintento programable o retorno (merma o re-stock según política). RN-DLV-04 Pedido de marketplace con reparto del marketplace: Delivery solo registra handoff (hora de recojo, courier externo).
## API
POST /shipments/:id/assign · /pickup · /deliver {evidence} · /fail {reason} · WS tracking por pedido (token público de seguimiento para el cliente final).
## Pruebas
Cobertura en frontera · asignación con 3 repartidores y cargas distintas · liquidación cuadra con pagos contra entrega · aislamiento.
## Aceptación
Link público de tracking sin autenticación con datos mínimos (estado + ETA), sin datos personales del repartidor más que nombre de pila.
