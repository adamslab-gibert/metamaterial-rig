#%% ===================================================================
#   WEB QUEUE ADD-ON for the rig program (rig_control_backend.py)
#
#   Paste this block into the rig program just AFTER the "Batch testing paths" cell
#   (after `path_tests = path_root + "/tests"`), and add the lines marked
#   "IN __main__" at the end of the `if __name__ == '__main__':` block.
#
#   What it does: every 3 s it writes web_queue/rig_status.json, and when the machine is
#   idle, set up and allowed to take web jobs, it runs the oldest job in web_queue/inbox
#   with the same programming and compression steps as run_test_set. This program never
#   touches the internet; lab/agent.py moves jobs and results between GitHub and this folder.
#
#   Allow web jobs:  create the file web_queue/accepting   (or run: python agent.py resume)
#   Stop web jobs:   delete it                              (or run: python agent.py pause)
#   The Halt button stops a web job too; the queue then stays paused until you resume it.
#   After any failed web job the queue pauses itself; check the machine, then resume.
# =====================================================================
import json as _json
import time as _time
import glob as _glob
from datetime import datetime as _dt, timezone as _tz

WEB_DIR = path_root + "/web_queue"
WEB_ACCEPT_FLAG = WEB_DIR + "/accepting"
WEB_FULL_EVERY = 10      # re-place every cell on every Nth web job (like full_every)
WEB_HOME_EVERY = 10      # home the gantries on every Nth web job (like home_every)
WEB_MAX_STROKE = 45.0    # [mm] stop and report a failure if 20 N is not reached by then
for _d in ("inbox", "running", "outbox", "archive"):
    os.makedirs(WEB_DIR + "/" + _d, exist_ok=True)

web_busy = False         # True while any long hardware action runs (web job or a button)
web_job = None           # issue number of the web job being run
web_job_count = 0        # web jobs run since the program started
web_last_error = ""      # set when a web job fails; cleared when the accept flag is created again
web_error_time = 0.0


def _web_now():
    return _dt.now(_tz.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _web_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        _json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def web_hardware_ready():
    """Both gantries and the force gauge connected, and the cell coordinates loaded."""
    try:
        ports = port_ender[0].isOpen() and port_ender[1].isOpen() and port_lc.isOpen()
        coords = any(abs(coords_uc[0][k][0]) > 0 for k in range(105))
        return bool(ports and coords)
    except Exception:
        return False


def web_write_status():
    if web_job is not None or web_busy:
        state = "busy"
    elif web_last_error:
        state = "error"
    else:
        state = "idle"
    _web_write_json(WEB_DIR + "/rig_status.json", {
        "state": state, "job": web_job, "accepting": os.path.exists(WEB_ACCEPT_FLAG),
        "hardware_ready": web_hardware_ready(), "message": web_last_error, "time": _time.time()})


def busy_wrap(fn):
    """Mark the machine busy while a button action runs, so no web job starts meanwhile."""
    def wrapped(*args):
        global web_busy
        web_busy = True
        try:
            return fn(*args)
        finally:
            web_busy = False
    return wrapped


def web_pause(reason):
    """Stop taking web jobs (removes the accept flag)."""
    global web_last_error, web_error_time
    web_last_error = reason
    web_error_time = _time.time()
    try:
        os.remove(WEB_ACCEPT_FLAG)
    except FileNotFoundError:
        pass
    append_hud_message("WEB QUEUE PAUSED: " + reason)


def web_clear_error():
    """Call after checking the machine (e.g. from the console) to allow web jobs again."""
    global web_last_error
    web_last_error = ""


def web_recover_interrupted():
    """At start-up: a job left in running/ was interrupted (program closed or crashed)."""
    for f in _glob.glob(WEB_DIR + "/running/*.json"):
        n = os.path.splitext(os.path.basename(f))[0]
        out = WEB_DIR + "/outbox/" + n
        os.makedirs(out, exist_ok=True)
        _web_write_json(out + "/done.json", {"ok": False, "message": "The rig program was restarted during this test.",
                                             "finished": _web_now()})
        os.remove(f)


def web_tick():
    """Called every 3 s by a QTimer. Also runs while a test is going (serial waits process events)."""
    try:
        web_write_status()
    except Exception as e:
        print("web status write failed:", e)
    global web_last_error
    if web_last_error and os.path.exists(WEB_ACCEPT_FLAG) and os.path.getmtime(WEB_ACCEPT_FLAG) > web_error_time:
        web_last_error = ""             # the operator allowed web jobs again after checking the machine
    if web_busy or web_job is not None or web_last_error:
        return
    if not os.path.exists(WEB_ACCEPT_FLAG) or not web_hardware_ready():
        return
    jobs = sorted(_glob.glob(WEB_DIR + "/inbox/*.json"), key=os.path.getmtime)
    if not jobs:
        return
    path_run = WEB_DIR + "/running/" + os.path.basename(jobs[0])
    os.replace(jobs[0], path_run)
    with open(path_run) as f:
        job = _json.load(f)
    run_web_job(job, path_run)


def _web_program(cur_pattern_local, last_pattern_local, full):
    """Place / remove inserts. Same moves as run_test_set; ender 0 empties cells, ender 1 fills them.
    When one ender has fewer cells than the other it simply waits (no padding moves)."""
    ind_e0, ind_e1 = [], []
    for count in range(105):
        if cur_pattern_local[count] == 0 and (full or last_pattern_local[count] == 1):
            ind_e0.append(count)
        if cur_pattern_local[count] == 1 and (full or last_pattern_local[count] == 0):
            ind_e1.append(count)
    steps = max(len(ind_e0), len(ind_e1))
    for count in range(steps):
        if is_halted:
            return
        uc0 = ind_e0[count] if count < len(ind_e0) else None
        uc1 = ind_e1[count] if count < len(ind_e1) else None
        read_both_ender_positions()
        send_to_ender_sync(["G0 Y" + "{:.2f}".format(par_y_code[2]) + " F" + "{:.0f}".format(fs_y_prog), "M114"], True, ["ok", "ok"])
        read_both_ender_positions()
        mv0 = "M114" if uc0 is None else "G0 X" + "{:.2f}".format(coords_uc[0][uc0][0]) + " Z" + "{:.2f}".format(coords_uc[0][uc0][1]) + " F" + "{:.0f}".format(fs_x_prog)
        mv1 = "M114" if uc1 is None else "G0 X" + "{:.2f}".format(coords_uc[1][uc1][0]) + " Z" + "{:.2f}".format(coords_uc[1][uc1][1]) + " F" + "{:.0f}".format(fs_x_prog)
        send_to_ender_sync([mv0, mv1], True, ["ok", "ok"])
        read_both_ender_positions()
        if is_halted:
            return
        if uc0 is not None:
            send_to_ender_sync(["G0 Y" + "{:.2f}".format(par_y_code[0]) + " F" + "{:.0f}".format(fs_y_prog), "M114"], True, ["ok", "ok"])
            read_both_ender_positions()
        if uc1 is not None:
            send_to_ender_sync(["G0 Y" + "{:.2f}".format(par_y_code[1]) + " F" + "{:.0f}".format(fs_y_prog), "M114"], True, ["ok", "ok"])
            read_both_ender_positions()
        send_to_ender_sync(["G0 Y" + "{:.2f}".format(par_y_code[2]) + " F" + "{:.0f}".format(fs_y_prog), "M114"], True, ["ok", "ok"])
        read_both_ender_positions()


def _web_home():
    send_to_ender_sync(["G0 Y" + "{:.2f}".format(par_y_code[2]) + " F" + "{:.0f}".format(fs_y_prog), "M114"], True, ["ok", "ok"])
    read_both_ender_positions()
    send_to_ender_sync(["G28 XR0", "G28 XR0"], True, ["ok", "ok"])
    read_both_ender_positions()
    send_to_ender_sync(["G28 ZR0", "G28 ZR0"], True, ["ok", "ok"])
    read_both_ender_positions()
    send_to_ender_sync(["G28 YR0", "M114"], True, ["ok", "ok"])
    read_both_ender_positions()


def run_web_job(job, path_run):
    """Build and test one pattern from the web queue; results go to web_queue/outbox/<issue>/."""
    global web_job, web_busy, web_job_count, cur_pattern, data_e, data_f, cur_force, cur_ender_pos
    n = str(job["issue"])
    out = WEB_DIR + "/outbox/" + n
    os.makedirs(out + "/images", exist_ok=True)
    started = _web_now()
    web_job, web_busy = int(n), True
    web_write_status()
    ok, message = False, ""
    try:
        code = "".join(ch for ch in str(job.get("pattern", "")) if ch in "01")
        if len(code) != 105:
            raise ValueError("pattern does not have 105 digits")
        append_hud_message("WEB JOB #" + n + ": programming pattern")
        prepare_for_test()
        cur_pattern = [int(ch) for ch in code]
        pickle_file = 'store_pattern.pk'
        last_str = None
        if os.path.exists(pickle_file):
            with open(pickle_file, 'rb') as fi:
                last_str = pickle.load(fi)
        full = (last_str is None) or (web_job_count % WEB_FULL_EVERY == 0)
        last_pattern_local = [int(ch) for ch in last_str] if last_str else [0] * 105
        if web_job_count % WEB_HOME_EVERY == 0:
            _web_home()
        _web_program(cur_pattern, last_pattern_local, full)
        if is_halted:
            raise RuntimeError("stopped by the operator (Halt) while placing inserts")
        with open(pickle_file, 'wb') as fi:
            pickle.dump(code, fi)

        # ---- compression test (as in run_test_set) ----
        append_hud_message("WEB JOB #" + n + ": compressing")
        go_to_rest_pos()
        data_e, data_f = [], []
        backend.reset_force_series.emit()
        read_force()
        read_both_ender_positions()
        send_to_ender_sync(["G0 E" + "{:.2f}".format(0) + " F" + "{:.0f}".format(fs_e_load), "M114"], True, ["ok", "ok"])
        read_force()
        read_both_ender_positions()
        cur_e_reading = cur_ender_pos[0][3]
        data_e.append(cur_e_reading)
        data_f.append(cur_force)
        count_image, last_e_record, last_f_record = 0, -1.0, -1.0
        frames_log = []                  # (frame, reading index, E, force, time) for the page's photo replay
        reached = False
        while not is_halted:
            send_to_ender_sync(["G0 E" + "{:.2f}".format(cur_e_reading + step_e_load) + " F" + "{:.0f}".format(fs_e_load), "M114"], True, ["ok", "ok"])
            read_force()
            read_both_ender_positions()
            cur_e_reading = cur_ender_pos[0][3]
            data_e.append(cur_e_reading)
            data_f.append(cur_force)
            if (cur_e_reading - last_e_record) >= 5.0 or (cur_force - last_f_record) >= 1.0:
                last_e_record, last_f_record = cur_e_reading, cur_force
                imageCapture.captureToFile(out + "/images/frame_" + str(count_image).zfill(5))
                frames_log.append((count_image, len(data_e) - 1, cur_e_reading, cur_force, _time.time()))
                count_image += 1
            if abs(cur_force) >= target_f_load:
                reached = True
                break
            if cur_e_reading >= WEB_MAX_STROKE:
                message = "20 N was not reached within %.0f mm; the test was stopped." % WEB_MAX_STROKE
                break
            update_series_plot()
        while not is_halted:            # unload back to E = 0
            send_to_ender_sync(["G0 E" + "{:.2f}".format(cur_e_reading - step_e_load) + " F" + "{:.0f}".format(fs_e_load), "M114"], True, ["ok", "ok"])
            read_force()
            read_both_ender_positions()
            cur_e_reading = cur_ender_pos[0][3]
            data_e.append(cur_e_reading)
            data_f.append(cur_force)
            if cur_e_reading <= 0:
                break
            update_series_plot()
        if is_halted:
            raise RuntimeError("stopped by the operator (Halt) during compression")
        with open(out + "/data.txt", "w") as f:
            for e_val, f_val in zip(data_e, data_f):
                f.write(str(e_val) + "," + str(f_val) + "\n")
        with open(out + "/code.txt", "w") as f:
            f.write(code)
        with open(out + "/images/frames.csv", "w") as f:
            f.write("frame,reading,E,force,time\n")
            for fr in frames_log:
                f.write("%d,%d,%s,%s,%.2f\n" % fr)
        ok = reached
        if not ok:
            web_pause(message)
    except Exception as e:
        message = str(e)
        web_pause("Web job #" + n + " failed: " + message)
    finally:
        web_job_count += 1
        _web_write_json(out + "/done.json", {"ok": ok, "message": message, "started": started, "finished": _web_now()})
        try:
            os.remove(path_run)
        except FileNotFoundError:
            pass
        web_job, web_busy = None, False
        web_write_status()
        append_hud_message("WEB JOB #" + n + (" finished" if ok else " FAILED: " + message))

# ===================== end of WEB QUEUE ADD-ON (first part) =====================

#%% IN __main__ : add these lines at the very end of the `if __name__ == '__main__':` block
#
#    web_recover_interrupted()
#    web_timer = QTimer()
#    web_timer.timeout.connect(web_tick)
#    web_timer.start(3000)
#
#  and wrap the long button actions so a web job cannot start while they run, e.g.
#    pme_qml.button_run_test_set_clicked.connect(busy_wrap(run_test_set))
#  (rig_control_backend_web.py has all of this done already).
