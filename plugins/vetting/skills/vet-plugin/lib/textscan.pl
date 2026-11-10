#!/usr/bin/perl
# Line-level checks on every file that is, or may be, text.
# Usage: textscan.pl <patterns.re> <outdir> < NUL-separated file list
# Writes one file per scan.sh section into <outdir>. Never executes anything it reads.
use strict; use warnings; no warnings 'utf8';
use Encode qw(decode FB_DEFAULT);
binmode STDOUT, ':encoding(UTF-8)';

my ($patfile, $out) = @ARGV;
open my $pf, '<', $patfile or die "$patfile: $!";
my $p = join '|', map { chomp; $_ } grep { !/^\s*(?:#|$)/ } <$pf>; close $pf;
my $PAT = qr/$p/i;
(my $lib = $patfile) =~ s{/[^/]*$}{};
open my $af, '<', "$lib/agent-files.re" or die "$lib/agent-files.re: $!";
my ($agentre) = grep { !/^\s*(?:#|$)/ } <$af>; close $af; chomp $agentre;
my $AGENT = qr/$agentre/;
# Files bigger than this are listed, not read: a sparse or padded file would stall the scan.
# scan.sh sets and checks it.
my $MAXB = $ENV{VET_MAX_BYTES} // '';
die "VET_MAX_BYTES must be a positive whole number\n" unless $MAXB =~ /^[1-9][0-9]*$/;

my %fh;
for my $n (qw(minified invisible invisible_counts nonascii patterns patterns_docs patterns_git patterns_binary headlines looks_binary mismatch agent toolarge)) {
  open $fh{$n}, '>:encoding(UTF-8)', "$out/$n.txt" or die "$out/$n.txt: $!";
}

# Formats whose content is not text. A file with one of these extensions gets only the
# pattern scan (into its own section) when its content is binary and looks the part.
# Content that is text is scanned as text whatever its extension or its first bytes say:
# several magics (GIF89a, true, wOFF, OTTO) are plain ASCII a script can start with.
my %MAGIC = (
  png => qr/^\x89PNG\r\n\x1a\n/, jpg => qr/^\xff\xd8\xff/, jpeg => qr/^\xff\xd8\xff/,
  gif => qr/^GIF8[79]a/, webp => qr/^RIFF....WEBP/s, ico => qr/^\x00\x00[\x01\x02]\x00/,
  pdf => qr/^%PDF-/, zip => qr/^PK(?:\x03\x04|\x05\x06)/, jar => qr/^PK\x03\x04/,
  vsix => qr/^PK\x03\x04/, whl => qr/^PK\x03\x04/, gz => qr/^\x1f\x8b/, tgz => qr/^\x1f\x8b/,
  bz2 => qr/^BZh/, xz => qr/^\xfd7zXZ\x00/, '7z' => qr/^7z\xbc\xaf\x27\x1c/,
  woff => qr/^wOFF/, woff2 => qr/^wOF2/, ttf => qr/^(?:\x00\x01\x00\x00|true)/, otf => qr/^OTTO/,
  wasm => qr/^\x00asm/, pyc => qr/^.{2}\r\n/s, class => qr/^\xca\xfe\xba\xbe/,
);
my %OPAQUE = map { $_ => 1 } qw(mp3 mp4 mov wav ogg webm m4a avi bmp tif tiff eot so dylib dll exe node o a lib bin dat icns psd);

# Displayed text: control, format and invisible characters become \x{..} so nothing in the
# output can hide or reorder itself.
my $HIDE = qr/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\x{FE00}-\x{FE0F}\x{E0100}-\x{E01EF}\x{115F}\x{1160}\x{3164}\x{FFA0}\x{2800}\x{034F}\x{17B4}\x{17B5}]/;
sub esc { my $s = shift; $s =~ s/(?!\t)($HIDE)/sprintf('\\x{%X}', ord $1)/ge; $s }
sub show_path { my $s = shift; $s =~ s{^\./}{}; esc($s) }
# A window of the line around a match, so hits deep in long lines stay visible.
sub window {
  my ($line, $at, $len) = @_;
  return esc($line) if length($line) <= 200;
  my $from = $at > 60 ? $at - 60 : 0;
  return ($from ? '…' : '') . esc(substr($line, $from, 200)) . ($from + 200 < length($line) ? '…' : '');
}
my $VS = qr/[\x{FE00}-\x{FE0F}\x{E0100}-\x{E01EF}]/;
# Scripts that put joiners inside words (Persian ZWNJ, Indic half forms).
my $JOINS = qr/[\p{Arabic}\p{Syriac}\p{Nko}\p{Mongolian}\p{Devanagari}\p{Bengali}\p{Gurmukhi}\p{Gujarati}\p{Oriya}\p{Tamil}\p{Telugu}\p{Kannada}\p{Malayalam}\p{Sinhala}]/;

# Binary content that looks the part: the pattern scan only, on the raw bytes.
sub binscan {
  my ($raw, $shown, $to) = @_;
  my $ln = 0;
  for my $line (split /\n/, $raw, -1) {
    $ln++;
    next unless $line =~ $PAT;
    my $l = decode('ISO-8859-1', $line);
    $l =~ $PAT;
    printf {$fh{$to}} "%s:%d: %s\n", $shown, $ln, window($l, $-[0], $+[0] - $-[0]);
  }
}

local $/ = "\0";
while (my $path = <STDIN>) {
  chomp $path;
  next unless -f $path && !-l $path;
  if (-s _ > $MAXB) { printf {$fh{toolarge}} "%s: %d bytes\n", show_path($path), -s _; next }
  open my $in, '<:raw', $path or next;
  my $raw = do { local $/; <$in> }; close $in;
  $raw //= '';
  my $shown = show_path($path);
  my ($ext) = $path =~ /\.([^.\/]+)$/; $ext = lc($ext // '');
  my $head = substr($raw, 0, 8192);
  # Files inside a .git directory (git's own, or planted there to be loaded from it).
  my $ingit = $path =~ m{(?:^|/)\.git/};

  my $textlike = $head !~ /\x00/ && ($head =~ tr/\x00-\x08\x0b\x0e-\x1f\x7f//) <= 0.02 * length($head);
  if ($MAGIC{$ext} || $OPAQUE{$ext}) {
    if (!length $raw) { next }
    elsif ($textlike) {
      print {$fh{mismatch}} "$shown: .$ext extension but the content is text"
        . ($MAGIC{$ext} && $raw =~ $MAGIC{$ext} ? " (it starts with the $ext signature: a polyglot)" : '') . "; scanned as text\n";
    } elsif ($MAGIC{$ext} && $raw !~ $MAGIC{$ext}) {
      print {$fh{mismatch}} "$shown: .$ext extension but content is not $ext; scanned as text\n";
    } else { binscan($raw, $shown, 'patterns_binary'); next }
  }
  if ($ingit && !$textlike) { binscan($raw, $shown, 'patterns_git'); next }

  # Encoding: UTF-16 by BOM or by NUL-byte layout, else lenient UTF-8.
  my $enc = 'UTF-8';
  if ($raw =~ /^\xff\xfe/) { $enc = 'UTF-16LE'; substr($raw, 0, 2) = '' }
  elsif ($raw =~ /^\xfe\xff/) { $enc = 'UTF-16BE'; substr($raw, 0, 2) = '' }
  elsif (length($head) >= 4) {
    my ($even, $odd) = (0, 0);
    for (my $i = 0; $i + 1 < length $head; $i += 2) {
      $even++ if substr($head, $i, 1) eq "\0"; $odd++ if substr($head, $i + 1, 1) eq "\0";
    }
    my $half = int(length($head) / 2);
    if ($odd > 0.4 * $half && $even < 0.05 * $half) { $enc = 'UTF-16LE' }
    elsif ($even > 0.4 * $half && $odd < 0.05 * $half) { $enc = 'UTF-16BE' }
  }
  my $nul = ($enc eq 'UTF-8' && $raw =~ /\x00/) ? 1 : 0;
  print {$fh{looks_binary}} "$shown: " . ($enc ne 'UTF-8' ? "$enc text" : 'contains NUL bytes') . "; scanned anyway\n"
    if $enc ne 'UTF-8' || $nul;
  my $text = decode($enc, $raw, FB_DEFAULT);
  my $is_md = $path =~ /\.(?:md|mdx|markdown)$/i;
  my $agentish = $path =~ $AGENT;
  # Plain documentation goes after code in the pattern section, so a README full of links
  # cannot push code hits past the cap.
  my $doc = !$agentish && $path =~ /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

  my (%inv_count, %other);
  my $ln = 0;
  for my $line (split /\n/, $text, -1) {
    $ln++;
    $line =~ s/\r$//;

    printf {$fh{minified}} "%s:%d: (%d chars) %s\n", $shown, $ln, length $line, esc(substr($line, 0, 160))
      if length($line) > 400;

    # Invisible characters. Allowed: a BOM opening the file, a joiner inside an emoji
    # sequence or a word of a script that uses joiners, VS15/VS16 after a symbol or keycap
    # base, and the tags of the three
    # subdivision flags (England, Scotland, Wales). Each exemption admits one character at a
    # time: a run of invisible characters is how a payload is encoded.
    my $l2 = $line;
    $l2 =~ s/\x{1F3F4}\x{E0067}\x{E0062}(?:\x{E0065}\x{E006E}\x{E0067}|\x{E0073}\x{E0063}\x{E0074}|\x{E0077}\x{E006C}\x{E0073})\x{E007F}/\x{1F3F4}/g;
    $l2 =~ s/^\x{FEFF}// if $ln == 1;
    my %c;
    while ($l2 =~ /($HIDE)/g) {
      my $o = ord $1; my $at = pos($l2) - 1;
      # Of the control characters, only those that rewrite what a terminal shows count:
      # escape (ANSI sequences can conceal text), CSI and backspace.
      next if ($o < 0x20 || ($o >= 0x7F && $o <= 0x9F)) && $o != 0x1B && $o != 0x9B && $o != 0x08;
      my $prev = $at > 0 ? substr($l2, $at - 1, 1) : '';
      my $next = substr($l2, $at + 1, 1);
      # Joiners: ZWJ between an emoji (or its skin tone or VS16) and the next emoji, or ZWJ and
      # ZWNJ between two letters of a script that joins. Never next to another invisible
      # character, and never between Latin letters: a joiner choice per gap is one bit.
      if ($o == 0x200C || $o == 0x200D) {
        next if $next !~ $HIDE
          && (($o == 0x200D && $prev =~ /[\p{So}\p{Sk}\x{FE0F}]/ && $next =~ /\p{So}/)
              || ($prev =~ $JOINS && $next =~ $JOINS));
      }
      # Variation selectors: only VS15/VS16 (text or emoji style) after a symbol or a keycap
      # base, which carries at most a bit per symbol. Any selector after a letter, a CJK
      # ideograph included, can be one of 256 and so carries a byte: ideographic variation
      # sequences are real but rare enough in code and docs to report.
      if ($o == 0xFE0E || $o == 0xFE0F) {
        next if $prev !~ $VS && $next !~ $VS
          && (($prev =~ /[^\x00-\x7f]/ && $prev !~ /\p{L}/) || $prev =~ /[0-9#*]/);
      }
      $c{$o}++;
    }
    for my $o (sort { $a <=> $b } keys %c) {
      printf {$fh{invisible}} "%s:%d U+%04X%s\n", $shown, $ln, $o, $c{$o} > 1 ? " x$c{$o}" : '';
      $inv_count{$o} += $c{$o};
    }
    while ($line =~ /([^\x00-\x7f])/g) { my $o = ord $1; $other{$o}++ unless $c{$o} }

    if ($line =~ $PAT) {
      printf {$fh{$ingit ? 'patterns_git' : $doc ? 'patterns_docs' : 'patterns'}} "%s:%d: %s\n", $shown, $ln, window($line, $-[0], $+[0] - $-[0]);
      (my $norm = $line) =~ s/^\s+|\s+$//g; $norm =~ s/\s+/ /g;
      print {$fh{headlines}} "$norm\n" unless $ingit;   # a copy planted in .git must not mask history
    }

    # Commands an agent host runs when it loads a prompt file, and the tools it grants.
    if ($is_md) {
      while ($line =~ /(!`[^`]+`)/g) { printf {$fh{agent}} "%s:%d: runs on load: %s\n", $shown, $ln, esc($1) }
      printf {$fh{agent}} "%s:%d: %s\n", $shown, $ln, esc($line)
        if $line =~ /^\s*(?:allowed-tools|hooks|mcpServers|permissionMode|disable-model-invocation)\s*:/i;
    }
  }
  printf {$fh{invisible_counts}} "%s: %s\n", $shown,
    join(', ', map { sprintf 'U+%04X x%d', $_, $inv_count{$_} } sort { $a <=> $b } keys %inv_count) if %inv_count;
  for my $o (sort { $a <=> $b } keys %other) {
    printf {$fh{nonascii}} "%7d %s U+%04X%s\n", $other{$o}, $shown, $o, chr($o) =~ /\p{Co}/ ? ' (private use)' : '';
  }
}
close $_ for values %fh;
