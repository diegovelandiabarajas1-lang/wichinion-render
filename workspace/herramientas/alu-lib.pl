# Núcleo de la ALU simulada de Wichi (lo usan alu.pl, la línea de comandos, y alu-mcp.pl, las herramientas del agente).
# Aritmética EXACTA con fracciones de enteros grandes: sin errores de coma flotante.
#   Exactas: suma, resta, multiplicación, división, raíz cuadrada, módulo y comparación.
#   Aproximada con 50 dígitos de guarda: logaritmo (nunca es un número racional salvo casos triviales).
# Redondeo final «al más cercano» (la mitad se aleja del cero) a N decimales: 15 por defecto, de 0 a 128.
package Alu;
use strict;
use warnings;
use Math::BigInt;
use Math::BigFloat;

our $MAX_DEC     = 128;
our $DEC_DEFAULT = 15;
my  $GUARDA      = 50;   # dígitos de guarda extra para el logaritmo

# Operaciones aritméticas con alias en español e inglés
our %OPS = (
    suma => 'suma', sumar => 'suma', add => 'suma', '+' => 'suma',
    resta => 'resta', restar => 'resta', sub => 'resta', '-' => 'resta',
    multiplicacion => 'mul', 'multiplicación' => 'mul', multiplicar => 'mul', mul => 'mul', '*' => 'mul', x => 'mul',
    division => 'div', 'división' => 'div', dividir => 'div', div => 'div', '/' => 'div',
);
our %SIGNO = (suma => '+', resta => '-', mul => '×', div => '÷');

# Lanza un error como [mensaje, código]; quien llama lo captura con eval.
sub _fail { my ($msg, $code) = @_; die [$msg, $code // 1] }

# Texto -> fracción exacta [N, D]
sub _parse {
    my ($s) = @_;
    _fail("falta un número") unless defined $s;
    $s =~ s/^\s+|\s+$//g;
    _fail("número demasiado largo") if length($s) > 4000;
    $s =~ /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/
        or _fail("«$s» no es un número válido (usa dígitos y punto decimal, p. ej. -12.5 o 3.2e-4)");
    my ($sg, $ent, $frac, $exp) = ($1, $2, defined $3 ? $3 : '', defined $4 ? $4 : 0);
    _fail("«$s» no es un número válido") if $ent eq '' && $frac eq '';
    _fail("exponente fuera de rango en «$s» (máximo ±1000)") if abs($exp) > 1000;
    my $digits = $ent . $frac;
    $digits =~ s/^0+(?=\d)//;
    my $scale = length($frac) - $exp;           # valor = digits / 10^scale
    my $n = Math::BigInt->new($digits eq '' ? '0' : $digits);
    $n->bneg() if $sg eq '-';
    my $d = Math::BigInt->bone();
    if ($scale >= 0) { $d = Math::BigInt->new(10)->bpow($scale) }
    else             { $n->bmul(Math::BigInt->new(10)->bpow(-$scale)) }
    return [$n, $d];
}

sub _norm {
    my ($f) = @_;
    my ($n, $d) = @$f;
    if ($d->is_neg) { $n = $n->copy->bneg; $d = $d->copy->bneg }
    my $g = Math::BigInt::bgcd($n->copy->babs, $d);
    if (!$g->is_zero && !$g->is_one) { $n = $n->copy->bdiv($g); $d = $d->copy->bdiv($g) }
    return [$n, $d];
}

# Valida y normaliza el número de decimales
sub check_dec {
    my ($v) = @_;
    return $DEC_DEFAULT unless defined $v && $v ne '';
    _fail("los decimales deben ser un entero entre 0 y $MAX_DEC (recibí «$v»)") unless $v =~ /^\d{1,4}$/;
    _fail("el máximo de decimales es $MAX_DEC (pediste $v)") if $v > $MAX_DEC;
    return $v + 0;
}

# Fracción [N, D] (D > 0) -> texto con $dec decimales, redondeo al más cercano (la mitad se aleja del cero)
sub _fmt {
    my ($f, $dec, $sin_ceros) = @_;
    my ($N, $D) = @$f;
    my $neg = $N->is_neg ? 1 : 0;
    my $scaled = $N->copy->babs * Math::BigInt->new(10)->bpow($dec);
    my $q = ($scaled * 2 + $D)->bdiv($D * 2);   # floor((2·|N|·10^dec + D) / (2·D))
    my $str = $q->bstr;
    $str = ('0' x ($dec + 1 - length $str)) . $str if length($str) < $dec + 1;
    my ($ent, $fra) = ($str, '');
    if ($dec > 0) { $ent = substr($str, 0, length($str) - $dec); $fra = substr($str, -$dec) }
    $fra =~ s/0+$// if $sin_ceros;
    my $res = $ent . ($fra ne '' ? ".$fra" : '');
    $res = "-$res" if $neg && $q->is_pos;       # «-0.000» se escribe «0.000»
    return $res;
}

# ───────── suma, resta, multiplicación y división ─────────
# calc($operacion, \@textos, $decimales, $sin_ceros) -> texto del resultado (en lista: resultado, op, decimales)
sub calc {
    my ($op_in, $texts, $dec, $sin_ceros) = @_;
    my $op = $OPS{lc($op_in // '')} // _fail("operación desconocida «" . ($op_in // '') . "». Usa suma, resta, multiplicacion o division.");
    _fail("hacen falta al menos dos números") if !$texts || @$texts < 2;
    _fail("demasiados números (máximo 50)") if @$texts > 50;
    $dec = check_dec($dec);

    my @nums = map { _parse($_) } @$texts;
    my $acc = $nums[0];
    for my $i (1 .. $#nums) {
        my ($n1, $d1, $n2, $d2) = (@$acc, @{ $nums[$i] });
        if    ($op eq 'suma')  { $acc = [$n1 * $d2 + $n2 * $d1, $d1 * $d2] }
        elsif ($op eq 'resta') { $acc = [$n1 * $d2 - $n2 * $d1, $d1 * $d2] }
        elsif ($op eq 'mul')   { $acc = [$n1 * $n2, $d1 * $d2] }
        else {
            _fail("división entre cero (el divisor número " . ($i + 1) . " es 0)", 2) if $n2->is_zero;
            $acc = [$n1 * $d2, $d1 * $n2];
        }
        $acc = _norm($acc);
    }
    my $res = _fmt($acc, $dec, $sin_ceros);
    return wantarray ? ($res, $op, $dec) : $res;
}

# ───────── raíz cuadrada (exacta) ─────────
# Se calcula k = floor(raíz(x·10^(2·dec))) con enteros y se sube 1 si x·10^(2·dec) >= (k + 1/2)^2: redondeo exacto al más cercano.
sub raiz {
    my ($txt, $dec, $sin_ceros) = @_;
    $dec = check_dec($dec);
    my ($N, $D) = @{ _norm(_parse($txt)) };
    _fail("la raíz cuadrada de un número negativo no es un número real", 3) if $N->is_neg;
    my $S4  = $N * Math::BigInt->new(10)->bpow(2 * $dec);        # numerador de S = x·10^(2dec)  (denominador D)
    my $flo = $S4->copy->bdiv($D);                                # floor(S)
    my $k   = $flo->copy->bsqrt;                                  # floor(sqrt(S))
    # ¿sqrt(S) >= k + 1/2 ?  <=>  4·S >= 4k² + 4k + 1
    my $lhs = $S4 * 4;
    my $rhs = ($k * $k * 4 + $k * 4 + 1) * $D;
    $k->binc if $lhs >= $rhs;
    my $res = _fmt([$k, Math::BigInt->new(10)->bpow($dec)], $dec, $sin_ceros);
    return wantarray ? ($res, $dec) : $res;
}

# ───────── logaritmo ─────────
# logaritmo($numero, $base, $decimales, $sin_ceros): base «e» (o vacío) = natural; también 10, 2 o cualquier número > 0 distinto de 1.
sub _bigfloat {
    my ($f, $digits) = @_;     # fracción -> BigFloat con $digits cifras significativas
    my $x = Math::BigFloat->new($f->[0]->bstr);
    return $x->bdiv(Math::BigFloat->new($f->[1]->bstr), $digits);
}

sub logaritmo {
    my ($txt, $base, $dec, $sin_ceros) = @_;
    $dec = check_dec($dec);
    my $x = _norm(_parse($txt));
    _fail("el logaritmo solo existe para números mayores que 0", 3) unless $x->[0]->is_pos;
    my $es_e = !defined $base || $base eq '' || lc($base) eq 'e';
    my ($b, $b_txt);
    unless ($es_e) {
        $b = _norm(_parse($base));
        _fail("la base del logaritmo debe ser mayor que 0", 3) unless $b->[0]->is_pos;
        _fail("la base del logaritmo no puede ser 1", 3) if $b->[0] == $b->[1];
    }
    # log(1) = 0 exacto
    if ($x->[0] == $x->[1]) { my $z = _fmt([Math::BigInt->bzero, Math::BigInt->bone], $dec, $sin_ceros); return wantarray ? ($z, $dec) : $z }
    # x = base  =>  1 exacto
    if (!$es_e && $x->[0] == $b->[0] && $x->[1] == $b->[1]) { my $u = _fmt([Math::BigInt->bone, Math::BigInt->bone], $dec, $sin_ceros); return wantarray ? ($u, $dec) : $u }

    my $mag = length($x->[0]->bstr) + length($x->[1]->bstr);      # cotas de tamaño para la precisión de trabajo
    my $A = $dec + $GUARDA + int($mag / 2) + 10;
    my $bx = _bigfloat($x, $A);
    my $ln = $bx->copy->blog(undef, $A);                          # logaritmo natural
    if (!$es_e) {
        my $bb = _bigfloat($b, $A);
        $ln->bdiv($bb->copy->blog(undef, $A), $A);                # log_b(x) = ln(x) / ln(b)
    }
    my $f = _norm(_parse($ln->bstr));
    my $res = _fmt($f, $dec, $sin_ceros);
    return wantarray ? ($res, $dec) : $res;
}

# ───────── módulo ─────────
# tipo «matematico» (por defecto): a − b·floor(a/b), el resultado lleva el signo del divisor (como en Python).
# tipo «resto»: a − b·trunc(a/b), el resultado lleva el signo del dividendo (como el % de C o JavaScript).
sub modulo {
    my ($ta, $tb, $dec, $tipo, $sin_ceros) = @_;
    $dec = check_dec($dec);
    $tipo = lc($tipo // 'matematico');
    $tipo = 'matematico' if $tipo eq '' || $tipo =~ /^mat/;
    _fail("tipo de módulo desconocido «$tipo» (usa matematico o resto)") unless $tipo eq 'matematico' || $tipo eq 'resto';
    my ($n1, $d1) = @{ _parse($ta) };
    my ($n2, $d2) = @{ _parse($tb) };
    _fail("módulo entre cero (el divisor es 0)", 2) if $n2->is_zero;
    my $num = $n1 * $d2;                    # a/b = num/den
    my $den = $d1 * $n2;
    if ($den->is_neg) { $num->bneg; $den->bneg }
    my $q = $tipo eq 'resto' ? $num->copy->btdiv($den) : $num->copy->bdiv($den);   # bdiv = división con suelo (floor)
    my $r = _norm([$n1 * $d2 - $n2 * $q * $d1, $d1 * $d2]);
    my $res = _fmt($r, $dec, $sin_ceros);
    return wantarray ? ($res, $tipo, $dec) : $res;
}

# ───────── comparación (exacta) ─────────
# Devuelve un hash: orden, minimo, maximo, iguales y, para dos números, relacion («<», «=», «>») y diferencia (b − a).
# La diferencia de dos decimales es otro decimal finito: se muestra COMPLETA, sin redondear.
sub comparar {
    my ($texts) = @_;
    _fail("hacen falta al menos dos números") if !$texts || @$texts < 2;
    _fail("demasiados números (máximo 50)") if @$texts > 50;
    my @raw = map { _parse($_) } @$texts;                  # denominadores = potencias de 10
    my @fr  = map { _norm([$_->[0]->copy, $_->[1]->copy]) } @raw;
    my $cmp = sub { my ($x, $y) = @_; ($x->[0] * $y->[1]) <=> ($y->[0] * $x->[1]) };
    my @idx = sort { $cmp->($fr[$a], $fr[$b]) || $a <=> $b } 0 .. $#fr;
    my $out = {
        orden  => [ map { $texts->[$_] } @idx ],
        minimo => $texts->[$idx[0]],
        maximo => $texts->[$idx[-1]],
    };
    if (@fr == 2) {
        my $c = $cmp->($fr[0], $fr[1]);
        $out->{relacion} = $c < 0 ? '<' : $c > 0 ? '>' : '=';
        my ($n1, $d1, $n2, $d2) = (@{ $raw[0] }, @{ $raw[1] });
        my $k = (sort { $b <=> $a } (length($d1->bstr) - 1, length($d2->bstr) - 1))[0];
        $k = 4000 if $k > 4000;
        my $dif = _fmt(_norm([$n2 * $d1 - $n1 * $d2, $d1 * $d2]), $k, 1);   # exacta y sin ceros finales
        $out->{diferencia} = $dif;
    }
    $out->{iguales} = (@fr > 1 && !grep { $cmp->($fr[0], $_) != 0 } @fr[1 .. $#fr]) ? 1 : 0;
    return $out;
}

1;
