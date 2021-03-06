/*
Copyright (C) 2013-2017 Bryan Hughes <bryan@nebri.us>

Aquarium Control is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Aquarium Control is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Aquarium Control.  If not, see <http://www.gnu.org/licenses/>.
*/

import { getTimes } from 'suncalc';
import { IDynamicScheduleEntry, IManualScheduleEntry } from './common/common';
import { state } from './state';
import { getConfig } from './db';
import { getServerConfig } from './config';

interface IScheduleEntry {
  date: Date;
  state: 'day' | 'night' | 'off';
  name: string;
}

let scheduleTimeout: NodeJS.Timer | null = null;
let dailySchedule: IScheduleEntry[] = [];

function createDate(hours: number, minutes: number, seconds: number): Date {
  const date = new Date();
  date.setHours(hours);
  date.setMinutes(minutes);
  date.setSeconds(seconds);
  return date;
}

function scheduleMidnightReset() {
  const midnightDate = new Date(createDate(0, 0, 0).getTime() + 24 * 60 * 60 * 1000);
  console.log(`Scheduling the daily schedule preparation for ${midnightDate}`);
  state.setNextTransitionTime(midnightDate);
  state.setNextTransitionState('off');
  scheduleTimeout = setTimeout(updateSchedule, midnightDate.getTime() - Date.now());
}

function scheduleNextTransition() {
  const nextScheduleEntry = dailySchedule.shift();
  if (!nextScheduleEntry) {
    console.warn('Internal Error: schedule queue is unexpectedly empty, prematurely scheduling midnight reset');
    scheduleMidnightReset();
    return;
  }
  const currentState = state.getState();
  console.log('Scheduling the next transition from ' + currentState.currentState +
    ' to ' + nextScheduleEntry.state + ' at ' + nextScheduleEntry.date);
  state.setNextTransitionTime(nextScheduleEntry.date);
  state.setNextTransitionState(nextScheduleEntry.state);
  setTimeout(() => {
    state.setCurrentState(nextScheduleEntry.state);
    if (dailySchedule.length) {
      scheduleNextTransition();
    } else {
      scheduleMidnightReset();
    }
  }, nextScheduleEntry.date.getTime() - Date.now());
}

export async function init(): Promise<void> {
  console.debug('[Scheduler]: initializing module');
  await updateSchedule();
  state.on('change-config', updateSchedule);
  console.debug('[Scheduler]: module initalized');
}

export async function updateSchedule(): Promise<void> {

  const currentSchedule = await getConfig();
  if (!currentSchedule) {
    throw new Error('Internal Error: currentSchedule is undefined');
  }

  // Cancel the previous schedule, if it was running
  if (scheduleTimeout) {
    clearTimeout(scheduleTimeout);
    scheduleTimeout = null;
  }

  // If we're in override mode, set that mode and exit early
  if (currentSchedule.mode === 'override') {
    console.log('[Scheduler]: setting override mode and skipping daily schedule creation');
    state.setCurrentState(currentSchedule.overrideState);
    state.setCurrentMode('override');
    return;
  }

  // Calculate the daily schedule
  console.log('[Scheduler]: creating the daily schedule');
  state.setCurrentMode('program');
  let entries = currentSchedule.schedule.map((entry) => {

    // If we're manual, calculate the time for today and return it
    if (entry.type === 'manual') {
      const manualDetails: IManualScheduleEntry = entry.details as IManualScheduleEntry;
      return {
        date: createDate(manualDetails.hour, manualDetails.minute, 0),
        state: entry.state,
        name: entry.name
      };
    }

    // If we're dynamic, use suncalc to figure out the time
    const dynamicDetails: IDynamicScheduleEntry = entry.details as IDynamicScheduleEntry;
    const times = getTimes(createDate(12, 0, 0), getServerConfig().latitude, getServerConfig().longitude);
    const date = times[dynamicDetails.event];
    if (!date) {
      const eventNames = Object.keys(times).join(', ');
      throw new Error(`Invalid dynamic event "${dynamicDetails.event}". Must be one of ${eventNames}.`);
    }
    return {
      date,
      state: entry.state,
      name: entry.name
    };
  });

  // Remove any events that occur after the next event, e.g. sunset is late enough that
  // it would occur after a manual time event due to time of year
  entries = entries.filter((entry, i) => {
    if (i === entries.length - 1) {
      return true;
    }
    const isValid = entry.date.getTime() < entries[i + 1].date.getTime();
    if (!isValid) {
      console.warn(`[Scheduler]: entry ${entry.name} occurs after the next entry and will be ignored`);
    }
    return isValid;
  });

  // Add an entry at the beginning of the day, e.g. 00:00:00, to kickstart the lights
  entries.unshift({
    date: createDate(0, 0, 0),
    state: entries[entries.length - 1].state,
    name: 'Initial state'
  });

  // Find the most recent schedule in the past to set the current lighting state
  // We set a 1 second buffer so that we don't miss anything while processing
  const currentTime = Date.now();
  const currentEntry = entries.filter((entry) => entry.date.getTime() <= currentTime + 1000).pop();
  if (!currentEntry) {
    throw new Error('Internal error: could not find current entry');
  }
  state.setCurrentState(currentEntry.state);

  // Remove the entries that are in the past, using the 1 second buffer as above
  entries = entries.filter((entry) => entry.date.getTime() > currentTime + 1000);

  // Store the entries to the global state for use by scheduleNextTransition
  dailySchedule = entries;
  console.log('[Scheduler]: the daily schedule is as follows: ');
  entries.forEach((entry) => console.log('  ' + entry.state + ': ' + entry.date));

  // If there are no entries left, we are done with the schedule for today and just
  // need to wait until tomorrow to do it again
  if (!entries.length) {
    scheduleMidnightReset();
  } else {
    scheduleNextTransition();
  }
}
