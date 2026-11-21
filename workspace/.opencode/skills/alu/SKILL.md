---
name: alu
description: "ALU simulada para cálculos exactos: suma, resta, multiplicación, división, raíz cuadrada, logaritmo, módulo y comparación, con 15 decimales por defecto y hasta 128. Usar SIEMPRE que haya que operar con decimales, cifras grandes, dinero, porcentajes, promedios, conversiones o cuando la persona pida una precisión concreta."
---

# ALU simulada (cálculo exacto)

Los modelos de lenguaje se equivocan al hacer cuentas «de cabeza» o con coma flotante. Para cualquier operación aritmética, **no calcules tú: usa la ALU**. Hace aritmética exacta (sin errores de coma flotante: `0.1 + 0.2` da `0.3` de verdad) con números de cualquier tamaño.

## Cómo se usa
**Primero mira tus herramientas.** Si ves las del servidor «alu», úsalas: `suma`, `resta`, `multiplicacion`, `division`, `raiz_cuadrada`, `logaritmo`, `modulo` y `comparacion` (suelen aparecer como `alu_suma`, `alu_logaritmo`…). Todas reciben los números **como texto** (`"0.1"`) y, salvo `comparacion`, `decimales` (0 a **128**, por defecto **15**) y `sin_ceros`. Si no están, usa el script con la herramienta de terminal:

`bash /workspace/herramientas/alu.sh <operación> ... [--dec N] [--sin-ceros] [--detalle]`

| Qué | Herramienta MCP | Script |
|---|---|---|
| Suma, resta, multiplicación, división (2 o más números, de izquierda a derecha) | `suma`, `resta`, `multiplicacion`, `division` | `alu.sh suma 0.1 0.2` |
| Raíz cuadrada (exacta; número ≥ 0) | `raiz_cuadrada` (`numero`) | `alu.sh raiz 2 --dec 50` |
| Logaritmo (base `e` por defecto; 10, 2 u otra > 0 distinta de 1) | `logaritmo` (`numero`, `base`) | `alu.sh logaritmo 1000 --base 10` (o `ln`, `log10`, `log2`) |
| Módulo con decimales: `matematico` (signo del divisor, como Python) o `resto` (signo del dividendo, como % de C/JS) | `modulo` (`a`, `b`, `tipo`) | `alu.sh modulo -10 3` · `--resto` |
| Comparación exacta (`<`, `=`, `>`, diferencia completa; con 3+ números los ordena) | `comparacion` (`numeros`) | `alu.sh comparar 0.3 0.30000000000000004` |

- El resultado se **redondea al más cercano** (la mitad se aleja del cero). Raíz, módulo y comparación son exactos; el logaritmo se calcula con 50 dígitos de guarda.
- Números con punto decimal (no coma), con signo y notación científica (`3.2e-4`).
- Errores claros: división o módulo entre 0, raíz de un negativo, logaritmo de un número ≤ 0 o base inválida, más de 128 decimales.

## Ejemplos
- IVA del 19 % de 1234.56 con 2 decimales: `multiplicacion ["1234.56","0.19"] decimales 2`.
- Promedio de 3 notas: `suma ["4.5","3.8","4.1"]`, luego `division [<suma>,"3"] decimales 2`.
- ¿`0.1 + 0.2` es igual a `0.3`? `suma` y luego `comparacion` (con coma flotante da falso; aquí da igual).
- Cuántas veces cabe: `modulo ["17.5","4"]` → 1.5.

## Reglas
- Para **cualquier** cuenta con decimales, cifras de más de 6 dígitos o dinero, usa la ALU y copia el resultado tal cual; no lo «corrijas» ni lo recalcules a mano.
- Para cuentas triviales con enteros pequeños (2 + 2) puedes responder sin ella.
- Di siempre cuántos decimales usaste cuando el resultado esté redondeado.
- No hay seno, coseno, potencias generales ni otras funciones: para potencias enteras pequeñas encadena multiplicaciones; para el resto, dilo en vez de aproximar de memoria.
