#!/usr/bin/perl
# Sensitive lines that some commit added and that no file on disk contains any more.
# Compares whole lines (whitespace-normalized), not matched tokens, so a harmless
# "https://" at HEAD cannot hide a deleted exfiltration call.
# Usage: git log --all -m -p --format=%x00%h\ %ad\ %an:\ %s ... | history.pl <patterns.re> <headlines.txt>
use strict; use warnings; no warnings 'utf8';
use Encode qw(decode FB_DEFAULT);
binmode STDOUT, ':encoding(UTF-8)';

my ($patfile, $headfile) = @ARGV;
open my $pf, '<', $patfile or die "$patfile: $!"; chomp(my $p = <$pf>); close $pf;
my $PAT = qr/$p/i;
my %head;
open my $hf, '<:encoding(UTF-8)', $headfile or die "$headfile: $!";
while (<$hf>) { chomp; $head{$_} = 1 } close $hf;

my $HIDE = qr/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\x{FE00}-\x{FE0F}\x{E0100}-\x{E01EF}\x{115F}\x{1160}\x{3164}\x{FFA0}\x{2800}\x{034F}\x{17B4}\x{17B5}]/;
sub esc { my $s = shift; $s =~ s/(?!\t)($HIDE)/sprintf('\\x{%X}', ord $1)/ge; $s }

my ($commit, $file, $hunk) = ('', '', 0);
my %seen;   # normalized line -> [oldest commit, file, original line]; git log runs newest first
while (my $l = <STDIN>) {
  chomp $l;
  if ($l =~ /^\0(.*)/) { $commit = decode('UTF-8', $1, FB_DEFAULT); $hunk = 0; next }
  if ($l =~ /^diff --git /) { $hunk = 0; next }
  if (!$hunk) {
    if ($l =~ /^\+\+\+ (?:b\/)?(.*)/) { $file = decode('UTF-8', $1, FB_DEFAULT) }
    $hunk = 1 if $l =~ /^@@ /;
    next;
  }
  next unless $l =~ /^\+(.*)/;
  my $s = decode('UTF-8', $1, FB_DEFAULT); $s =~ s/\r$//;
  next unless $s =~ $PAT;
  (my $norm = $s) =~ s/^\s+|\s+$//g; $norm =~ s/\s+/ /g;
  next if $head{$norm};
  $seen{$norm} = [$commit, $file, $s];
}
for my $k (sort { $seen{$a}[1] cmp $seen{$b}[1] || $a cmp $b } keys %seen) {
  my ($c, $f, $s) = @{$seen{$k}};
  $s =~ s/^\s+//;
  $s = substr($s, 0, 200) . '…' if length $s > 200;
  printf "%s: %s\n    added in %s\n", esc($f), esc($s), esc($c);
}
