use strict;
use warnings;
use Fcntl qw(:DEFAULT :flock :mode O_NOFOLLOW);
use JSON::PP;
use Cwd qw(abs_path);
use File::Basename qw(dirname);
use File::Path qw(make_path);
use IO::Select;
use Time::HiRes qw(time sleep);
$| = 1;
my $json = JSON::PP->new->canonical->utf8;
my ($request, $path, $guard, $legacy_guard, $coordinator, $identity, $parent_identity, $lock, $owned_guard, $stable_id, $boot_identity, $coordinator_bytes);
sub fail { die "$_[0]\n"; }
sub emit { print $json->encode($_[0]), "\n" or fail('companion_lock_response_pipe_lost'); }
sub safe_path {
  my ($value) = @_;
  fail('companion_lock_path_invalid') unless $value =~ m{^/} && $value !~ m{(?:^|/)\.\.?(/|$)} && $value !~ /\0/;
  my $current = '';
  for my $part (split m{/}, $value) {
    next unless length $part; $current .= "/$part";
    my @st = lstat($current); fail('companion_lock_symlink_not_allowed') if @st && S_ISLNK($st[2]);
  }
}
sub checked_stat {
  my ($value, $directory) = @_;
  my @st = lstat($value);
  if (!@st) { fail('companion_lock_path_read_failed') unless $!{ENOENT}; return undef; }
  fail('companion_lock_path_type_invalid') unless $directory ? S_ISDIR($st[2]) : S_ISREG($st[2]);
  fail('companion_lock_path_not_private') unless $st[4] == $< && ($st[2] & 0022) == 0;
  fail('companion_lock_marker_too_large') if !$directory && $st[7] > 16384;
  return { dev => "$st[0]", ino => "$st[1]" };
}
sub same { return defined($_[0]) && defined($_[1]) && $json->encode($_[0]) eq $json->encode($_[1]); }
sub read_marker {
  my ($value) = @_;
  my $stat = checked_stat($value, 0); return undef unless $stat;
  sysopen(my $fh, $value, O_RDONLY | O_NOFOLLOW) or fail('companion_lock_marker_read_failed');
  my @fd = stat($fh); fail('companion_lock_marker_identity_changed') unless same($stat, {dev=>"$fd[0]",ino=>"$fd[1]"});
  local $/; my $text = <$fh>; close($fh);
  fail('companion_lock_marker_identity_changed') unless same($stat, checked_stat($value, 0));
  my $value_json = eval { $json->decode($text) };
  return { identity => $stat, text => $text, owner => $value_json };
}
sub liveness {
  my ($pid) = @_;
  return 'unknown' unless defined($pid) && $pid =~ /^[1-9][0-9]*$/ && $pid < 2147483648;
  return 'live' if kill(0, $pid);
  return $!{ESRCH} ? 'dead' : 'unknown';
}
sub parent_alive {
  fail('companion_lock_parent_lost') unless getppid() == $request->{pid} && liveness($request->{pid}) eq 'live';
  if (IO::Select->new(\*STDIN)->can_read(0)) {
    my $byte; my $size = sysread(STDIN, $byte, 1);
    fail('companion_lock_parent_pipe_lost') unless defined($size) && $size > 0;
    fail('companion_lock_parent_protocol_invalid');
  }
}
sub coordinator_current {
  safe_path($path);
  fail('companion_lock_parent_identity_changed') unless abs_path(dirname($path)) eq dirname($path);
  fail('companion_lock_parent_identity_changed') unless same($parent_identity, checked_stat(dirname($path), 1));
  fail('companion_lock_coordinator_identity_changed') unless same($identity, checked_stat($coordinator, 0));
  fail('companion_lock_coordinator_identity_changed') if defined($coordinator_bytes) && read_marker($coordinator)->{text} ne $coordinator_bytes;
}
sub boot_identity {
  if ($^O eq 'darwin') {
    open(my $fh, '-|', '/usr/sbin/sysctl', '-n', 'kern.boottime') or fail('companion_lock_boot_identity_unavailable');
    local $/; my $value=<$fh>; close($fh) or fail('companion_lock_boot_identity_unavailable');
    return "darwin:$1:$2" if $value =~ /sec\s*=\s*([0-9]+),\s*usec\s*=\s*([0-9]+)/;
  } elsif ($^O eq 'linux') {
    open(my $fh, '<', '/proc/sys/kernel/random/boot_id') or fail('companion_lock_boot_identity_unavailable');
    my $value=<$fh>; close($fh); chomp($value);
    return "linux:$value" if $value =~ /^[0-9a-f-]{36}$/;
  }
  fail('companion_lock_boot_identity_unavailable');
}
sub coordinator_binding { return {path=>$coordinator,%$identity,defined($stable_id) ? (id=>$stable_id) : ()}; }
sub phase {
  my ($phase) = @_;
  coordinator_current(); parent_alive();
  if (($request->{testPauseAt} // '') eq $phase) {
    emit({ phase => $phase, helperPid => $$, coordinator => $identity });
    my $byte; my $size = sysread(STDIN, $byte, 1);
    fail('companion_lock_parent_pipe_lost') unless defined($size) && $size == 1 && $byte eq 'C';
    coordinator_current(); parent_alive();
  }
  fail('companion_lock_fixture_write_failed') if ($request->{testFaultAt} // '') eq $phase;
}
sub valid_owner {
  my ($owner, $schema) = @_;
  return 0 unless ref($owner) eq 'HASH';
  my $v3_schema=$schema; $v3_schema =~ s/\.v2$/.v3/;
  my $v3=($owner->{schema}//'') eq $v3_schema;
  return 0 unless (($owner->{schema}//'') eq $schema || $v3)
    && $json->encode($owner->{pid}) =~ /^[1-9][0-9]*$/ && liveness($owner->{pid}) ne 'unknown'
    && ($owner->{token}//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    && ($owner->{acquireId}//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    && ref($owner->{coordinator}) eq 'HASH';
  if ($v3) {
    return 0 unless ($owner->{bootIdentity}//'') =~ /^(darwin:[0-9]+:[0-9]+|linux:[0-9a-f-]{36})$/;
    my $bound=$owner->{coordinator};
    my $exact=same($bound,coordinator_binding());
    # Device renumbering alone cannot authorize recovery. The persistent random
    # coordinator ID, exact path/inode, different kernel boot and dead owner
    # must agree while this helper holds the original coordinator flock.
    my $crossboot=($owner->{bootIdentity} ne $boot_identity) && liveness($owner->{pid}) eq 'dead'
      && ($schema eq 'companion_lock.v2' || liveness($owner->{workPid}) eq 'dead')
      && same($bound,{path=>$coordinator,dev=>$bound->{dev},ino=>$identity->{ino},id=>$stable_id})
      && defined($bound->{dev}) && $bound->{dev} =~ /^[0-9]+$/;
    return 0 unless $exact || $crossboot;
  } else { return 0 unless same($owner->{coordinator},{path=>$coordinator,%$identity}); }
  my %keys = map { $_ => 1 } ($schema eq 'companion_lock.v2' ? qw(schema pid token acquireId coordinator) : qw(schema pid workPid token acquireId transactionId coordinator));
  $keys{bootIdentity}=1 if $v3;
  return 0 if grep { !$keys{$_} } keys %$owner;
  return 0 if $schema ne 'companion_lock.v2' && (!defined($owner->{workPid}) || $json->encode($owner->{workPid}) !~ /^[1-9][0-9]*$/);
  return 0 if $schema ne 'companion_lock.v2' && ($owner->{transactionId}//'') !~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return 1;
}
sub remove_exact {
  my ($value, $snapshot) = @_;
  coordinator_current(); parent_alive();
  my $fresh = read_marker($value);
  fail('companion_lock_marker_identity_changed') unless $fresh && same($fresh->{identity}, $snapshot->{identity}) && $fresh->{text} eq $snapshot->{text};
  unlink($value) or fail('companion_lock_marker_remove_failed');
}
sub clear_guard {
  my ($snapshot) = @_;
  remove_exact($guard, $snapshot);
}
sub write_new {
  my ($value, $owner, $kind) = @_;
  coordinator_current(); parent_alive();
  my $stage = "$path.staged-$request->{token}-$$-$kind";
  sysopen(my $fh, $stage, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or fail('companion_lock_marker_create_failed');
  phase("${kind}_stage_created");
  my $bytes = $json->encode($owner)."\n";
  # A killed writer can leave incomplete private staging bytes, never a final marker.
  my $half = int(length($bytes)/2);
  syswrite($fh, substr($bytes,0,$half)) == $half or fail('companion_lock_marker_write_failed');
  phase("${kind}_stage_partial");
  syswrite($fh, substr($bytes,$half)) == length($bytes)-$half or fail('companion_lock_marker_write_failed');
  close($fh) or fail('companion_lock_marker_close_failed');
  phase("${kind}_stage_written");
  my $staged = read_marker($stage);
  fail('companion_lock_marker_write_not_verified') unless $staged && $staged->{text} eq $bytes && same($staged->{owner}, $owner);
  phase("${kind}_before_publish");
  # link is atomic and refuses an existing destination (including foreign markers).
  link($stage, $value) or fail('companion_lock_marker_publish_failed');
  phase("${kind}_published");
  my $stored = read_marker($value);
  fail('companion_lock_marker_write_not_verified') unless $stored && same($stored->{identity},$staged->{identity}) && $stored->{text} eq $bytes;
  remove_exact($stage, $staged);
  return $stored;
}
sub work_blocker {
  my ($work) = @_;
  return undef unless $work;
  my $owner = $work->{owner};
  if (!valid_owner($owner, 'companion_lock.v2')) {
    my $pid = ref($owner) eq 'HASH' ? $owner->{pid} : $work->{text} =~ /^([1-9][0-9]*)\s*$/ ? $1 : undef;
    return liveness($pid) eq 'live' || liveness($pid) eq 'unknown' && defined($pid)
      ? 'companion_lock_owner_live_or_unverifiable'
      : defined($pid) ? 'companion_legacy_lock_maintenance_required' : 'companion_lock_owner_uncertain';
  }
  return liveness($owner->{pid}) ne 'dead' ? 'companion_lock_owner_live_or_unverifiable' : undef;
}
my $result;
eval {
  my $line = <STDIN>; fail('companion_lock_request_invalid') unless defined($line) && length($line) < 8192;
  $request = $json->decode($line); fail('companion_lock_request_invalid') unless ref($request) eq 'HASH'
    && ($request->{action}//'') =~ /^(acquire|release|inspect|quarantine)$/ && ($request->{pid}//0) == getppid()
    && ($request->{token}//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  $path = $request->{lockPath}; safe_path($path);
  make_path(dirname($path), { mode => 0700 }) unless -e dirname($path);
  fail('companion_lock_parent_identity_changed') unless abs_path(dirname($path)) eq dirname($path);
  $parent_identity = checked_stat(dirname($path), 1);
  ($guard, $legacy_guard, $coordinator) = ("$path.guard.v2", "$path.guard", "$path.coordinator");
  safe_path($coordinator);
  sysopen($lock, $coordinator, O_RDWR | O_CREAT | O_NOFOLLOW, 0600) or fail('companion_lock_coordinator_open_failed');
  my @fd = stat($lock); $identity = { dev=>"$fd[0]", ino=>"$fd[1]" };
  fail('companion_lock_coordinator_not_private') unless S_ISREG($fd[2]) && $fd[4] == $< && ($fd[2] & 0022) == 0;
  my $deadline = time() + $request->{waitMs}/1000;
  while (!flock($lock, LOCK_EX | LOCK_NB)) {
    fail('companion_lock_coordinator_busy') if time() >= $deadline;
    parent_alive(); sleep(0.01);
  }
  $boot_identity=boot_identity();
  my $stored_coordinator=read_marker($coordinator);
  if ($stored_coordinator->{text} eq '') {
    $coordinator_bytes='';
  } else {
    my $stored=$stored_coordinator->{owner};
    fail('companion_lock_coordinator_identity_uncertain') unless ref($stored) eq 'HASH'
      && same($stored,{schema=>'companion_lock_coordinator.v1',id=>$stored->{id}})
      && ($stored->{id}//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    $stable_id=$stored->{id}; $coordinator_bytes=$stored_coordinator->{text};
  }
  coordinator_current(); phase('before_binding');
  emit({ transactionBinding=>{coordinator=>coordinator_binding(),acquireId=>$request->{acquireId},helperPid=>$$} });
  phase('before_marker');
  my $work = read_marker($path);
  my @legacy_stat = lstat($legacy_guard);
  fail('companion_lock_path_read_failed') if !@legacy_stat && !$!{ENOENT};
  my $guard_record = read_marker($guard);
  if ($request->{action} eq 'quarantine') {
    my $plan=$request->{maintenance};
    fail('companion_lock_maintenance_valid_plan_required') unless ref($plan) eq 'HASH' && !@legacy_stat && $guard_record
      && $path =~ m{/(setup\.lock|control-plane-sync\.lock)$}
      && same($plan->{coordinatorIdentity},$identity)
      && (!$work && !$plan->{workIdentity} || $work && same($plan->{workIdentity},$work->{identity}) && $plan->{workBytes} eq $work->{text})
      && same($plan->{guardIdentity},$guard_record->{identity}) && $plan->{guardBytes} eq $guard_record->{text};
    my $exclusion=$plan->{exclusion};
    fail('companion_lock_maintenance_scheduling_exclusion_required') unless ref($exclusion) eq 'HASH'
      && $exclusion->{excluded} && $exclusion->{allEntrypointsExcluded} && $exclusion->{legacyActorsExcluded}
      && ($exclusion->{lockPath}//'') eq $path && length($exclusion->{source}//'')
      && time()*1000-$exclusion->{observedAtMs} >= 0 && time()*1000-$exclusion->{observedAtMs} <= 5000;
    for my $record ($work,$guard_record) {
      next unless $record;
      my $owner=$record->{owner};
      my $schema=$work && $record == $work ? 'companion_lock.v2' : 'companion_lock_guard.v2';
      my %keys=map {$_=>1} ($schema eq 'companion_lock.v2' ? qw(schema pid token acquireId coordinator) : qw(schema pid workPid token acquireId transactionId coordinator));
      fail('companion_lock_maintenance_owner_malformed') unless ref($owner) eq 'HASH' && ($owner->{schema}//'') eq $schema
        && scalar(keys %$owner) == scalar(keys %keys) && !(grep {!$keys{$_}} keys %$owner)
        && ($owner->{token}//'') =~ /^[0-9a-f-]{36}$/ && ($owner->{acquireId}//'') =~ /^[0-9a-f-]{36}$/
        && ref($owner->{coordinator}) eq 'HASH' && same($owner->{coordinator},{path=>$coordinator,dev=>$owner->{coordinator}{dev},ino=>$owner->{coordinator}{ino}})
        && ($owner->{coordinator}{dev}//'') =~ /^[0-9]+$/ && ($owner->{coordinator}{ino}//'') =~ /^[0-9]+$/;
      fail('companion_lock_maintenance_owner_live_or_unknown') unless liveness($owner->{pid}) eq 'dead';
      fail('companion_lock_maintenance_owner_live_or_unknown') if $schema ne 'companion_lock.v2' && liveness($owner->{workPid}) ne 'dead';
      fail('companion_lock_maintenance_owner_malformed') if $schema ne 'companion_lock.v2' && ($owner->{transactionId}//'') !~ /^[0-9a-f-]{36}$/;
    }
    my $g=$guard_record->{owner};
    fail('companion_lock_guard_work_binding_mismatch') if $work && ($work->{owner}{pid} != $g->{workPid}
      || $work->{owner}{token} ne $g->{token} || $work->{owner}{acquireId} ne $g->{acquireId}
      || !same($work->{owner}{coordinator},$g->{coordinator}));
    my $recovery=$plan->{recoveryPath}; safe_path($recovery);
    fail('companion_lock_maintenance_recovery_directory_not_private') unless dirname(dirname($recovery)) eq dirname($path)
      && dirname($recovery) eq dirname($path).'/lock-recovery' && checked_stat($recovery,1);
    my @preserved;
    for my $pair ([$path,$work,'work.lock'],[$guard,$guard_record,'guard.v2']) {
      my ($source,$snapshot,$name)=@$pair; next unless $snapshot;
      my $destination="$recovery/$name";
      coordinator_current(); parent_alive();
      link($source,$destination) or fail('companion_lock_maintenance_archive_failed');
      my $archived=read_marker($destination);
      fail('companion_lock_maintenance_preservation_not_verified') unless same($archived->{identity},$snapshot->{identity}) && $archived->{text} eq $snapshot->{text};
      remove_exact($source,$snapshot);
      push @preserved,{originalPath=>$source,path=>$destination};
    }
    $result={applied=>JSON::PP::true,preservationVerified=>JSON::PP::true,originalsAbsentVerified=>JSON::PP::true,
      kernelExclusionVerified=>JSON::PP::true,recoveryPath=>$recovery,preserved=>\@preserved};
  } elsif ($request->{action} eq 'inspect') {
    $result = { inspected=>JSON::PP::true, work=>$work ? $work->{owner} : undef,
      guard=>$guard_record ? $guard_record->{owner} : undef, legacyGuardPresent=>@legacy_stat ? JSON::PP::true : JSON::PP::false, coordinator=>$identity,
      workTokenMatches=>($work && ref($work->{owner}) eq 'HASH' && ($work->{owner}{token}//'') eq $request->{token}) ? JSON::PP::true : JSON::PP::false };
    # Reconcile only this invocation's original commit, never dispatch a new acquire.
    if ($request->{reconcileAcquire} && !@legacy_stat && liveness($request->{expectedHelperPid}) eq 'dead'
      && same($request->{coordinator},coordinator_binding())
      && ($request->{acquireId}//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) {
      my $original_guard = !$guard_record || valid_owner($guard_record->{owner},'companion_lock_guard.v2')
        && $guard_record->{owner}{pid} == $request->{expectedHelperPid}
        && $guard_record->{owner}{workPid} == $request->{pid}
        && $guard_record->{owner}{token} eq $request->{token}
        && $guard_record->{owner}{acquireId} eq $request->{acquireId}
        && $guard_record->{owner}{transactionId} eq $request->{acquireId};
      my $original_work = $work && valid_owner($work->{owner},'companion_lock.v2')
        && $work->{owner}{pid} == $request->{pid} && $work->{owner}{token} eq $request->{token}
        && $work->{owner}{acquireId} eq $request->{acquireId};
      if ($original_guard && $original_work) {
        phase('after_original_acquire_proof');
        $result = { %$result, acquired=>JSON::PP::true, %{$work->{owner}}, lockPath=>$path,
          workIdentity=>$work->{identity},workBytes=>$work->{text},originalCommitRecovered=>JSON::PP::true };
      } elsif ($original_guard && $guard_record && !$work && !$request->{readOnlyReconciliation}) {
        clear_guard($guard_record);
        phase('after_original_guard_cleanup');
        $result->{guard}=undef; $result->{originalGuardRecovered}=JSON::PP::true;
        $result->{acquired}=JSON::PP::false; $result->{originalCommitRecovered}=JSON::PP::false;
        $result->{workLeaseCommitted}=JSON::PP::false;
      }
    }
    if ($request->{reconcileRelease} && !@legacy_stat && liveness($request->{expectedHelperPid}) eq 'dead'
      && same($request->{coordinator},coordinator_binding())
      && ref($request->{workIdentity}) eq 'HASH' && defined($request->{workBytes})) {
      my $held_owner = eval { $json->decode($request->{workBytes}) };
      my $held_valid = valid_owner($held_owner,'companion_lock.v2') && $held_owner->{pid} == $request->{pid}
        && $held_owner->{token} eq $request->{token} && $held_owner->{acquireId} eq ($request->{acquireId}//'');
      my $original_guard = !$guard_record || valid_owner($guard_record->{owner},'companion_lock_guard.v2')
        && $guard_record->{owner}{pid} == $request->{expectedHelperPid} && $guard_record->{owner}{workPid} == $request->{pid}
        && $guard_record->{owner}{token} eq $request->{token} && $guard_record->{owner}{acquireId} eq ($request->{acquireId}//'')
        && $guard_record->{owner}{transactionId} eq ($request->{releaseId}//'');
      my $original_work = !$work || same($request->{workIdentity},$work->{identity}) && $request->{workBytes} eq $work->{text};
      if ($held_valid && $original_guard && $original_work) {
        phase('before_original_release_unlink');
        remove_exact($path,$work) if $work;
        clear_guard($guard_record) if $guard_record;
        phase('after_original_release_finalized');
        $result = {%$result,released=>JSON::PP::true,originalReleaseRecovered=>JSON::PP::true,work=>undef,guard=>undef};
      }
    }
    if ($request->{verifyReleaseAbsence} && !$work && !$guard_record && !@legacy_stat
      && liveness($request->{expectedHelperPid}) eq 'dead' && same($request->{coordinator},coordinator_binding())
      && ref($request->{workIdentity}) eq 'HASH' && defined($request->{workBytes})) {
      my $held_owner=eval {$json->decode($request->{workBytes})};
      if(valid_owner($held_owner,'companion_lock.v2') && $held_owner->{pid} == $request->{pid}
        && $held_owner->{token} eq $request->{token} && $held_owner->{acquireId} eq ($request->{acquireId}//'')) {
        $result={%$result,released=>JSON::PP::true,originalReleaseRecovered=>JSON::PP::true,finalizerAckRecovered=>JSON::PP::true};
      }
    }
  } else {
    fail('companion_lock_guard_legacy_or_uncertain') if @legacy_stat;
    # A failed held-lease comparison must not even clear an otherwise dead guard.
    if ($request->{action} eq 'release') {
      fail('companion_lock_ownership_changed') unless $work && valid_owner($work->{owner},'companion_lock.v2')
        && $work->{owner}{token} eq $request->{token} && $work->{owner}{pid} == $request->{pid}
        && $work->{owner}{acquireId} eq ($request->{acquireId}//'')
        && same($request->{coordinator},$work->{owner}{coordinator})
        && same($request->{workIdentity},$work->{identity}) && ($request->{workBytes}//'') eq $work->{text};
    }
    if ($guard_record) {
      fail('companion_lock_guard_legacy_or_uncertain') unless $guard_record && valid_owner($guard_record->{owner}, 'companion_lock_guard.v2');
      my $g = $guard_record->{owner};
      fail('companion_lock_guard_owner_live_or_unverifiable') unless liveness($g->{pid}) eq 'dead';
      fail('companion_lock_guard_work_binding_mismatch') if $work && (!valid_owner($work->{owner}, 'companion_lock.v2')
        || $work->{owner}{token} ne $g->{token} || $work->{owner}{acquireId} ne $g->{acquireId} || $work->{owner}{pid} != $g->{workPid});
      fail('companion_lock_guard_work_owner_live_or_unverifiable') if liveness($g->{workPid}) ne 'dead'
        && !($request->{action} eq 'release' && $g->{workPid} == $request->{pid} && $g->{token} eq $request->{token});
      clear_guard($guard_record);
    }
    if ($request->{action} eq 'acquire') {
      my $blocker = work_blocker($work); fail($blocker) if $blocker;
      if ($work && !valid_owner($work->{owner}, 'companion_lock.v2')) { fail('companion_legacy_lock_maintenance_required'); }
    } else {
      fail('companion_lock_ownership_changed') unless $work && valid_owner($work->{owner}, 'companion_lock.v2')
        && $work->{owner}{token} eq $request->{token} && $work->{owner}{pid} == $request->{pid};
      fail('companion_lock_ownership_changed') unless same($request->{coordinator}, $work->{owner}{coordinator});
      fail('companion_lock_ownership_changed') unless same($request->{workIdentity},$work->{identity}) && ($request->{workBytes}//'') eq $work->{text};
    }
    my $acquire_id = $request->{action} eq 'acquire' ? $request->{acquireId} : $work->{owner}{acquireId};
    fail('companion_lock_request_invalid') unless ($acquire_id//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    my $transaction_id = $request->{action} eq 'acquire' ? $acquire_id : $request->{releaseId};
    fail('companion_lock_request_invalid') unless ($transaction_id//'') =~ /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!defined($stable_id) && $request->{action} eq 'acquire') {
      $stable_id=$request->{token};
      $coordinator_bytes=$json->encode({schema=>'companion_lock_coordinator.v1',id=>$stable_id})."\n";
      seek($lock,0,0) or fail('companion_lock_coordinator_write_failed');
      syswrite($lock,$coordinator_bytes)==length($coordinator_bytes) or fail('companion_lock_coordinator_write_failed');
      coordinator_current();
      emit({transactionBinding=>{coordinator=>coordinator_binding(),acquireId=>$request->{acquireId},helperPid=>$$}});
    }
    $owned_guard = write_new($guard, { schema=>defined($stable_id) ? 'companion_lock_guard.v3' : 'companion_lock_guard.v2', defined($stable_id) ? (bootIdentity=>$boot_identity) : (), pid=>$$, workPid=>$request->{pid}, token=>$request->{token}, acquireId=>$acquire_id, transactionId=>$transaction_id, coordinator=>coordinator_binding() }, 'guard');
    phase('after_guard');
    if ($request->{action} eq 'acquire') {
      remove_exact($path, $work) if $work;
      my $lease = { schema=>'companion_lock.v3', bootIdentity=>$boot_identity, pid=>$request->{pid}, token=>$request->{token}, acquireId=>$acquire_id, coordinator=>coordinator_binding() };
      my $stored_work=write_new($path, $lease, 'work'); phase('after_work');
      $result = { acquired=>JSON::PP::true, %$lease, lockPath=>$path,workIdentity=>$stored_work->{identity},workBytes=>$stored_work->{text} };
    } else {
      phase('during_release'); remove_exact($path, $work); phase('after_release');
      $result = { released=>JSON::PP::true };
    }
    clear_guard($owned_guard); $owned_guard = undef;
    phase('before_response');
  }
  emit({ result=>$result });
  1;
} or do {
  my $code = $@; $code =~ s/\s+$//; $code = 'companion_lock_transaction_failed' unless $code =~ /^companion_[a-z0-9_]+$/;
  if ($owned_guard && $request && getppid() == $request->{pid}) {
    eval { clear_guard($owned_guard); };
  }
  eval { emit({ result=>{acquired=>JSON::PP::false, released=>JSON::PP::false, exactBlocker=>$code} }); };
  exit(3);
};
