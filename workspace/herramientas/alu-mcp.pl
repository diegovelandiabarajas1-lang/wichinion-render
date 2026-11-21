#!/usr/bin/perl
# Servidor MCP (por entrada/salida estándar) con las herramientas de la ALU simulada de Wichi.
# El agente las ve como herramientas propias del servidor «alu»:
#   suma, resta, multiplicacion, division, raiz_cuadrada, logaritmo, modulo y comparacion.
# Solo usa módulos que vienen con Perl (JSON::PP, Math::BigInt, Math::BigFloat): no necesita instalar nada.
use strict;
use warnings;
use utf8;                                # los textos de este archivo son caracteres (se codifican al enviar)
use File::Basename qw(dirname);
use JSON::PP;
require(dirname(__FILE__) . '/alu-lib.pl');

binmode(STDIN,  ':raw');
binmode(STDOUT, ':raw');
$| = 1;

# allow_bignum: si el cliente manda un número JSON con más precisión que un double, se conserva exacto
my $json = JSON::PP->new->utf8->allow_bignum->canonical;

my $NOTA = ' ALU simulada: aritmética exacta (sin errores de coma flotante) con hasta 128 decimales. ÚSALA SIEMPRE en lugar de calcular tú o con código de coma flotante cuando haya decimales, cifras grandes, dinero o porcentajes.';

sub prop_decimales {
    return { type => 'integer', minimum => 0, maximum => $Alu::MAX_DEC, default => $Alu::DEC_DEFAULT,
             description => "Decimales del resultado, de 0 a $Alu::MAX_DEC (por defecto $Alu::DEC_DEFAULT). Se redondea al más cercano." };
}
sub prop_sin_ceros { return { type => 'boolean', default => JSON::PP::false, description => 'Quitar los ceros sobrantes al final del resultado.' } }
sub prop_numero    { my ($d) = @_; return { type => 'string', description => $d . ' Como TEXTO entre comillas (p. ej. "0.1"), con punto decimal; signo y notación científica permitidos.' } }
sub prop_lista {
    return { type => 'array', minItems => 2, maxItems => 50, items => { type => 'string' },
             description => 'Los números, como TEXTO entre comillas (p. ej. ["0.1","0.2"]) para no perder precisión. Punto decimal, signo y notación científica permitidos.' };
}

my %TOOLS = (
    suma => { op => 'suma', desc => 'Suma exacta de dos o más números.',
              schema => { numeros => prop_lista(), decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['numeros'] },
    resta => { op => 'resta', desc => 'Resta exacta (a − b − c …, de izquierda a derecha).',
               schema => { numeros => prop_lista(), decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['numeros'] },
    multiplicacion => { op => 'mul', desc => 'Multiplicación exacta de dos o más números.',
                        schema => { numeros => prop_lista(), decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['numeros'] },
    division => { op => 'div', desc => 'División exacta (a ÷ b ÷ c …, de izquierda a derecha); el divisor no puede ser 0.',
                  schema => { numeros => prop_lista(), decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['numeros'] },
    raiz_cuadrada => { op => 'raiz', desc => 'Raíz cuadrada exacta (redondeada al más cercano) de un número mayor o igual que 0.',
                       schema => { numero => prop_numero('El número (≥ 0).'), decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['numero'] },
    logaritmo => { op => 'log', desc => 'Logaritmo de un número mayor que 0, en la base que se pida (e por defecto; también 10, 2 o cualquier base > 0 distinta de 1). Se calcula con 50 dígitos de guarda.',
                   schema => { numero => prop_numero('El número (> 0).'),
                               base => { type => 'string', default => 'e', description => 'Base del logaritmo: "e" (natural, por defecto), "10", "2" u otro número > 0 distinto de 1, como texto.' },
                               decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['numero'] },
    modulo => { op => 'mod', desc => 'Módulo (a mod b) con decimales. Por defecto «matematico»: el resultado lleva el signo del divisor (como en Python); con tipo «resto» lleva el signo del dividendo (como % en C o JavaScript). b no puede ser 0.',
                schema => { a => prop_numero('Dividendo.'), b => prop_numero('Divisor (distinto de 0).'),
                            tipo => { type => 'string', enum => ['matematico', 'resto'], default => 'matematico', description => 'matematico (signo del divisor) o resto (signo del dividendo).' },
                            decimales => prop_decimales(), sin_ceros => prop_sin_ceros() }, req => ['a', 'b'] },
    comparacion => { op => 'cmp', desc => 'Compara con exactitud dos o más números (sin errores de redondeo). Con dos números responde «a < b», «a = b» o «a > b» y la diferencia b − a; con más, los ordena y da mínimo y máximo. La diferencia sale completa, sin redondear.',
                     schema => { numeros => prop_lista() }, req => ['numeros'] },
);

sub tools_list {
    my @out;
    for my $name (sort keys %TOOLS) {
        my $t = $TOOLS{$name};
        push @out, { name => $name, description => $t->{desc} . $NOTA,
                     inputSchema => { type => 'object', properties => $t->{schema}, required => $t->{req} } };
    }
    return \@out;
}

sub reply { my ($id, $result) = @_; print $json->encode({ jsonrpc => '2.0', id => $id, result => $result }), "\n" }
sub reply_err { my ($id, $code, $msg) = @_; print $json->encode({ jsonrpc => '2.0', id => $id, error => { code => $code, message => $msg } }), "\n" }

sub texto { my ($v) = @_; return defined $v ? "$v" : undef }     # los números JSON llegan exactos (bignum) y se pasan como texto

sub ok  { my ($t) = @_; return { content => [{ type => 'text', text => $t }] } }
sub err { my ($m) = @_; utf8::decode($m); return { isError => JSON::PP::true, content => [{ type => 'text', text => "ERROR: $m" }] } }

sub call_tool {
    my ($name, $a) = @_;
    my $t = $TOOLS{$name} or return err("herramienta desconocida «$name»");
    my $sc = $a->{sin_ceros} ? 1 : 0;
    my $nota = sub { my ($d) = @_; return $sc ? 'sin ceros finales' : "$d decimales" };
    my $out = eval {
        my $op = $t->{op};
        if ($op eq 'raiz') {
            my ($r, $d) = Alu::raiz(texto($a->{numero}), $a->{decimales}, $sc);
            return ok("$r\n(raíz cuadrada, " . $nota->($d) . ", redondeo al más cercano)");
        }
        if ($op eq 'log') {
            my ($r, $d) = Alu::logaritmo(texto($a->{numero}), texto($a->{base}), $a->{decimales}, $sc);
            return ok("$r\n(" . $nota->($d) . ", redondeo al más cercano)");
        }
        if ($op eq 'mod') {
            my ($r, $tipo, $d) = Alu::modulo(texto($a->{a}), texto($a->{b}), $a->{decimales}, texto($a->{tipo}), $sc);
            return ok("$r\n(módulo $tipo, " . $nota->($d) . ")");
        }
        if ($op eq 'cmp') {
            my @n = map { texto($_) } @{ $a->{numeros} // [] };
            my $c = Alu::comparar(\@n);
            if (exists $c->{relacion}) {
                return ok("$n[0] $c->{relacion} $n[1]\ndiferencia ($n[1] − $n[0]): $c->{diferencia}");
            }
            return ok($c->{iguales} ? "todos son iguales: $n[0]"
                     : "orden ascendente: " . join(' < ', @{ $c->{orden} }) . "\nmínimo: $c->{minimo}\nmáximo: $c->{maximo}");
        }
        my @n = map { texto($_) } @{ $a->{numeros} // [] };
        my ($r, undef, $d) = Alu::calc($op, \@n, $a->{decimales}, $sc);
        return ok("$r\n(" . $nota->($d) . ", redondeo al más cercano)");
    };
    return $out if $out;
    my $e = $@;
    return err(ref $e eq 'ARRAY' ? $e->[0] : "fallo interno: $e");
}

while (my $line = <STDIN>) {
    $line =~ s/^\s+|\s+$//g;
    next if $line eq '';
    my $msg = eval { $json->decode($line) };
    if (!$msg || ref $msg ne 'HASH') { reply_err(undef, -32700, 'JSON no válido'); next }
    my ($method, $id, $p) = ($msg->{method} // '', $msg->{id}, $msg->{params} // {});
    if ($method eq 'initialize') {
        reply($id, {
            protocolVersion => ($p->{protocolVersion} // '2025-06-18'),
            capabilities => { tools => { listChanged => JSON::PP::false } },
            serverInfo => { name => 'wichi-alu', version => '1.1.0' },
            instructions => 'ALU simulada: suma, resta, multiplicación, división, raíz cuadrada, logaritmo, módulo y comparación exactos; 15 decimales por defecto (hasta 128).',
        });
    }
    elsif ($method eq 'tools/list')  { reply($id, { tools => tools_list() }) }
    elsif ($method eq 'tools/call')  { reply($id, call_tool($p->{name} // '', $p->{arguments} // {})) }
    elsif ($method eq 'ping')        { reply($id, {}) }
    elsif ($method =~ m{^notifications/}) { }                       # sin respuesta
    elsif (defined $id)              { reply_err($id, -32601, "método no soportado: $method") }
}
