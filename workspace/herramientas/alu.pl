#!/usr/bin/perl
# ALU simulada de Wichi (línea de comandos). Ver alu-lib.pl.
#
# Uso:
#   alu.sh <suma|resta|multiplicacion|division> <a> <b> [<c> ...] [--dec N]
#   alu.sh raiz <x>                      raíz cuadrada (exacta)
#   alu.sh logaritmo <x> [--base B]      logaritmo (base e por defecto; también ln, log10, log2)
#   alu.sh modulo <a> <b> [--resto]      módulo (signo del divisor) o, con --resto, resto (signo del dividendo)
#   alu.sh comparar <a> <b> [<c> ...]    compara con exactitud (<, =, >) y ordena
# Opciones comunes: --dec N (0 a 128, 15 por defecto), --sin-ceros, --detalle
use strict;
use warnings;
no warnings 'once';                      # variables de paquete de alu-lib.pl usadas aquí una sola vez
use File::Basename qw(dirname);
require(dirname(__FILE__) . '/alu-lib.pl');

sub fail {
    my ($msg, $code) = @_;
    print STDERR "ERROR: $msg\n";
    exit($code // 1);
}

sub uso {
    return "Uso: alu.sh <suma|resta|multiplicacion|division> <a> <b> [<c> ...] [--dec N]\n"
         . "     alu.sh raiz <x>  |  alu.sh logaritmo <x> [--base B]  |  alu.sh modulo <a> <b> [--resto]  |  alu.sh comparar <a> <b> [<c> ...]\n"
         . "  --dec N       decimales del resultado (0 a $Alu::MAX_DEC; por defecto $Alu::DEC_DEFAULT)\n"
         . "  --sin-ceros   quita los ceros sobrantes al final\n"
         . "  --detalle     muestra la operación completa y no solo el resultado\n"
         . "  --base B      base del logaritmo (e por defecto)\n"
         . "  --resto       en «modulo»: resto con el signo del dividendo (como % de C o JavaScript)\n";
}

my @args = @ARGV;
my ($dec, $sin_ceros, $detalle, $base, $resto) = (undef, 0, 0, undef, 0);
my @pos;
while (@args) {
    my $a = shift @args;
    if ($a eq '--dec' || $a eq '-d' || $a eq '--decimales') {
        fail("falta el número de decimales después de $a\n" . uso()) unless @args;
        $dec = shift @args;
    }
    elsif ($a =~ /^--dec=(.*)$/) { $dec = $1 }
    elsif ($a eq '--base' || $a eq '-b') { fail("falta la base después de $a") unless @args; $base = shift @args }
    elsif ($a =~ /^--base=(.*)$/) { $base = $1 }
    elsif ($a eq '--sin-ceros')  { $sin_ceros = 1 }
    elsif ($a eq '--detalle')    { $detalle = 1 }
    elsif ($a eq '--resto')      { $resto = 1 }
    elsif ($a eq '-h' || $a eq '--ayuda' || $a eq '--help') { print uso(); exit 0 }
    else { push @pos, $a }
}
fail("falta la operación.\n" . uso()) unless @pos;
my $op_in = lc shift @pos;
my %RAIZ = map { $_ => 1 } qw(raiz raíz raiz_cuadrada sqrt);
my %LOG  = (logaritmo => undef, log => undef, ln => 'e', log10 => '10', log2 => '2');
my %MOD  = map { $_ => 1 } qw(modulo módulo mod %);
my %CMP  = map { $_ => 1 } qw(comparar comparacion comparación cmp);

sub run {
    if ($RAIZ{$op_in}) {
        fail("«raiz» necesita un solo número.\n" . uso()) unless @pos == 1;
        my $r = Alu::raiz($pos[0], $dec, $sin_ceros);
        return $detalle ? "√$pos[0] = $r" : $r;
    }
    if (exists $LOG{$op_in}) {
        fail("«logaritmo» necesita un solo número (la base va con --base).\n" . uso()) unless @pos == 1;
        my $b = defined $LOG{$op_in} ? $LOG{$op_in} : $base;
        my $r = Alu::logaritmo($pos[0], $b, $dec, $sin_ceros);
        my $nb = !defined $b || $b eq '' ? 'e' : $b;
        return $detalle ? "log base $nb de $pos[0] = $r" : $r;
    }
    if ($MOD{$op_in}) {
        fail("«modulo» necesita dos números.\n" . uso()) unless @pos == 2;
        my $r = Alu::modulo($pos[0], $pos[1], $dec, $resto ? 'resto' : 'matematico', $sin_ceros);
        return $detalle ? "$pos[0] mod $pos[1] = $r" : $r;
    }
    if ($CMP{$op_in}) {
        my $c = Alu::comparar(\@pos);
        if (exists $c->{relacion}) {
            my $s = "$pos[0] $c->{relacion} $pos[1]";
            return $detalle ? "$s\ndiferencia ($pos[1] − $pos[0]): $c->{diferencia}" : $s . "\ndiferencia ($pos[1] − $pos[0]): $c->{diferencia}";
        }
        return $c->{iguales} ? "todos son iguales: $pos[0]"
             : "orden ascendente: " . join(' < ', @{ $c->{orden} }) . "\nmínimo: $c->{minimo}\nmáximo: $c->{maximo}";
    }
    my ($res, $op, $d) = Alu::calc($op_in, \@pos, $dec, $sin_ceros);
    if ($detalle) {
        my $nd = $sin_ceros ? 'sin ceros finales' : "$d decimales";
        return join(" $Alu::SIGNO{$op} ", @pos) . " = $res   ($nd, redondeo al más cercano)";
    }
    return $res;
}

my $salida;
eval { $salida = run(); 1 }
    or do {
        my $e = $@;
        if (ref $e eq 'ARRAY') { fail($e->[0] . ($e->[0] =~ /^(operación desconocida|hacen falta)/ ? "\n" . uso() : ''), $e->[1]) }
        fail("fallo interno: $e", 3);
    };
print "$salida\n";
exit 0;
