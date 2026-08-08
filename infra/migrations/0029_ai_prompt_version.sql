-- 0029 — Versión del prompt en la traza (spec 19 §7, T5.31).
--
-- La traza de RN-AIA-05 ya decía QUÉ respondió el agente y con qué reglas,
-- herramientas y fuentes. Le faltaba **con qué prompt**, que es justo el dato
-- que hace falta cuando la calidad se degrada: sin él, «desde el martes
-- responde peor» no se puede atribuir a nada, porque el prompt es texto que
-- vive en el código y cambia sin dejar rastro en los datos.
--
-- Con la versión guardada, la pregunta «¿qué cambió entre las conversaciones
-- buenas y las malas?» se contesta con un GROUP BY, y la suite dorada puede
-- afirmar «pasó con v3» en vez de «pasó».
ALTER TABLE ai_traces ADD COLUMN prompt_version text;

COMMENT ON COLUMN ai_traces.prompt_version IS
  'Versión del prompt de sistema (@sahana/ai-prompts). NULL en resoluciones que no llamaron al modelo.';

-- Índice por versión + resolución: la consulta real es «¿qué proporción de
-- respuestas se bloqueó con v3 frente a v2?», y es la que decide si un prompt
-- nuevo se queda o se revierte.
CREATE INDEX idx_ai_traces_prompt_version
  ON ai_traces (tenant_id, prompt_version, resolution)
  WHERE prompt_version IS NOT NULL;
