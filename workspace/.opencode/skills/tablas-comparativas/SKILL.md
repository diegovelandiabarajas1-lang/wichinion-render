---
name: tablas-comparativas
description: "Genera tablas comparativas detalladas entre tecnologías, arquitecturas, ideas de negocio o productos, con criterios adaptados al tipo, puntajes ponderados y veredicto. Usar al comparar opciones o decidir entre alternativas."
---

# Tablas Comparativas

Construye comparaciones que ayuden a DECIDIR, no solo a listar diferencias. Una buena tabla comparativa responde tres preguntas: ¿en qué se diferencian realmente?, ¿cuál gana según lo que el usuario necesita?, y ¿en qué escenario cambiaría la respuesta?

## Flujo de trabajo

1. **Identifica el tipo de comparación** (ver tipos abajo) y el contexto del usuario: para qué la necesita, qué restricciones tiene (presupuesto, equipo, plazo, stack actual). Si el contexto no está en la conversación, haz UNA pregunta corta o declara los supuestos explícitamente al inicio de la tabla — nunca compares en el vacío.
2. **Investiga antes de escribir.** Si la comparación depende de hechos del mundo real que cambian (precios, versiones, límites de planes, rendimiento actual), búscalos en la web y cita las fuentes. Nunca inventes cifras: un precio o benchmark inventado es peor que una celda que diga "verificar". Lo que no puedas confirmar, márcalo como "~aprox." o "sin dato".
3. **Elige los criterios según el tipo** (listas abajo como punto de partida, no camisa de fuerza): quita los irrelevantes para este caso y agrega los que el contexto pida. Entre 6 y 10 criterios suele ser el punto dulce — menos es superficial, más diluye la decisión.
4. **Llena la tabla** con las reglas de formato de abajo.
5. **Cierra con el veredicto**: puntajes ponderados, ganador para ESTE contexto, y escenarios donde ganaría cada otra opción.

## Tipos de comparación y sus criterios base

### Tecnologías y librerías (frameworks, lenguajes, bases de datos, APIs, cloud)
Madurez y mantenimiento (última versión, actividad), curva de aprendizaje, rendimiento en el caso de uso concreto, ecosistema y comunidad, documentación, integración con el stack actual del usuario, costo (licencia + hosting), riesgo de abandono/lock-in.

### Arquitecturas y enfoques de código (monolito vs microservicios, SQL vs NoSQL, opciones de implementación)
Complejidad de implementación, mantenibilidad a 1-2 años, escalabilidad ante el crecimiento esperado (no el hipotético), esfuerzo de migración desde lo que existe, testabilidad, riesgo técnico, experiencia del equipo con el enfoque, reversibilidad de la decisión.

Aquí los "datos" salen del código y contexto del usuario, no de la web: si hay un repositorio o descripción del sistema, básate en eso y dilo.

### Ideas y propuestas de negocio (proyectos, modelos de cobro, propuestas comerciales)
Esfuerzo/costo de implementación, tiempo hasta el primer ingreso, potencial de retorno, riesgo principal (nómbralo, no lo puntúles en abstracto), diferenciación frente a lo que ya existe, dependencias externas (clientes, permisos, terceros), qué tan reversible es intentarlo.

### Productos y servicios (SaaS, proveedores, planes, hardware)
Precio real del escenario del usuario (no "desde $X" — calcula el plan que usaría), características que le importan (no el checklist completo del vendedor), límites y letra pequeña, soporte y SLA, facilidad de salida (exportar datos, cancelar), reputación/estabilidad del proveedor.

Si la comparación mezcla tipos (ej. "¿desarrollo esto a medida o pago un SaaS?"), combina criterios de ambos tipos y dilo explícitamente.

## Reglas de formato

- **Filas = criterios, columnas = opciones.** Todas las opciones se evalúan en TODOS los criterios — una celda vacía es un hueco en la decisión.
- **Celdas concretas, no adjetivos.** "Gratis hasta 50k lecturas/día, luego USD 25/mes" informa; "económico" no. "Requiere aprender Rust (~2-4 semanas para el equipo)" informa; "curva de aprendizaje media" no. El adjetivo puede ir, pero acompañando al dato.
- **Puntaje 1-5 por criterio** en la misma celda o en columna aparte, siempre con la justificación visible. El puntaje sin dato al lado es opinión disfrazada.
- **Pondera los criterios** según el contexto del usuario (pesos que sumen 100% o alto/medio/bajo) y muestra el total ponderado por opción — verifica la aritmética del total antes de entregar. Si el usuario no dio contexto para ponderar, usa pesos iguales y dilo.
- **Emoji con moderación**: ✅ / ⚠️ / ❌ como refuerzo visual del puntaje está bien; no decores cada celda.

## Veredicto (siempre, al final)

Tres partes, breves:

1. **Recomendación**: cuál gana para este contexto y en una frase por qué — la razón decisiva, no un resumen de la tabla.
2. **Cuándo elegir cada otra opción**: una línea por opción perdedora describiendo el escenario en que sería la correcta. Si ningún escenario realista la favorece, dilo — mantener una opción "por cortesía" contamina la decisión.
3. **El riesgo de la recomendación**: qué podría hacer que la elección recomendada salga mal, y cómo detectarlo temprano.

## Formato de entrega

- **Por defecto: tabla Markdown en la respuesta.** Comparaciones de 2-4 opciones y ≤10 criterios se leen mejor ahí mismo, sin fricción.
- **Documento/artefacto HTML con diseño** cuando: hay 5+ opciones o la tabla no cabe legible en el chat, el usuario la va a compartir o presentar a alguien más, o lo pide. Ahí sí: encabezado con el contexto y supuestos, tabla con semáforos de color, sección de veredicto destacada.
- **Hoja de cálculo** solo si el usuario quiere manipular los pesos o datos él mismo, o lo pide.
- Responde en el idioma del usuario (normalmente español).