/* eslint-disable camelcase,no-await-in-loop */
import RandomState from '../utils/RandomState';
import { Trials, Domain, JOB_STATE_NEW, JOB_STATE_RUNNING, JOB_STATE_ERROR, JOB_STATE_DONE } from './base';

const getTimeStatmp = () => new Date().getTime();

class FMinIter {
  constructor(
    algo, domain, trials,
    {
      rng,
      catchExceptions = false,
      max_queue_len = 1,
      max_evals = Number.MAX_VALUE,
    } = {},
    params = {}
  ) {
    this.catchExceptions = catchExceptions;
    this.algo = algo;
    this.domain = domain;
    this.trials = trials;
    this.callbacks = params.callbacks || {};
    this.max_queue_len = max_queue_len;
    this.max_evals = max_evals;
    this.rng = rng;
  }
  async serial_evaluate(N = -1) {
    const { onExperimentBegin, onExperimentEnd } = this.callbacks;
    let n = N;
    let stopped = false;
    for (let i = 0; i < this.trials.dynamicTrials.length; i += 1) {
      const trial = this.trials.dynamicTrials[i];
      if (trial.state === JOB_STATE_NEW) {
        trial.state = JOB_STATE_RUNNING;
        const now = getTimeStatmp();
        trial.book_time = now;
        trial.refresh_time = now;
        try {
          if (typeof onExperimentBegin === 'function') {
            if (await onExperimentBegin(i, trial) === true) {
              stopped = true;
            }
          }
          // eslint-disable-next-line no-await-in-loop
          const result = await this.domain.evaluate(trial.args);
          trial.state = JOB_STATE_DONE;
          trial.result = result;
          trial.refresh_time = getTimeStatmp();
        } catch (e) {
          trial.state = JOB_STATE_ERROR;
          trial.error = `${e}, ${e.message}`;
          trial.refresh_time = getTimeStatmp();
          if (!this.catchExceptions) {
            this.trials.refresh();
            throw e;
          }
        }
        if (typeof onExperimentEnd === 'function') {
          if (await onExperimentEnd(i, trial) === true) {
            stopped = true;
          }
        }
      }
      n -= 1;
      if (n === 0 || stopped) {
        break;
      }
    }
    this.trials.refresh();
    return stopped;
  }

  run = async (N) => {
    const { trials, algo } = this;
    let n_queued = 0;

    const get_queue_len = () => this.trials.countByStateUnsynced(JOB_STATE_NEW);

    let stopped = false;
    while (n_queued < N) {
      let qlen = get_queue_len();
      while (qlen < this.max_queue_len && n_queued < N) {
        const n_to_enqueue = Math.min(this.max_queue_len - qlen, N - n_queued);
        const new_ids = trials.newTrialIds(n_to_enqueue);
        trials.refresh();
        const new_trials = algo(
          new_ids, this.domain, trials,
          this.rng.randrange(0, (2 ** 31) - 1)
        );
        console.assert(new_ids.length >= new_trials.length);
        if (new_trials.length) {
          this.trials.insertTrialDocs(new_trials);
          this.trials.refresh();
          n_queued += new_trials.length;
          qlen = get_queue_len();
        } else {
          stopped = true;
          break;
        }
      }
      stopped = stopped || await this.serial_evaluate();
      if (stopped) {
        break;
      }
    }
    const qlen = get_queue_len();
    if (qlen) {
      const msg = `Exiting run, not waiting for ${qlen} jobs.`;
      console.error(msg);
    }
  };

  exhaust = async () => {
    const n_done = this.trials.length;
    await this.run(this.max_evals - n_done);
    this.trials.refresh();
    return this;
  }
}

export default async (fn, space, algo, max_evals, params = {}) => {
  const {
    trials: defTrials, rng: rngDefault,
    catchExceptions = false,
  } = params;

  let rng;
  if (rngDefault) {
    rng = rngDefault;
  } else {
    rng = new RandomState();
  }
  let trials;
  if (!defTrials) {
    trials = new Trials();
  } else {
    trials = defTrials;
  }

  const domain = new Domain(fn, space, params);

  const rval = new FMinIter(
    algo, domain, trials,
    { max_evals, rng, catchExceptions },
    params
  );
  await rval.exhaust();
  return trials;
};
