/*
 * Copyright 2018 DoubleDutch, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { PureComponent } from 'react'
import { AsyncStorage, StyleSheet, Text, View } from 'react-native'

// rn-client must be imported before FirebaseConnector
import client, { TitleBar } from '@doubledutch/rn-client'
import {
  provideFirebaseConnectorToReactComponent,
  mapPushedDataToStateObjects,
} from '@doubledutch/firebase-connector'
import { ServerValue } from '@firebase/database'

import debounce from 'lodash.debounce'

import { NavStackRouter, Route } from './NavStackRouter'
import _Main from './Main'
import Welcome from './Welcome'
import serverTimeFactory from './shared/firebaseServerTime'
import getMeetingState from './shared/getMeetingState'

const HomeView = ({ fbc, suggestedTitle, path }) => {
  const title = (path || '').startsWith('/select')
    ? 'Select People'
    : suggestedTitle || 'Magic Hour'

  const Main = () => <Root pageComponent={_Main} fbc={fbc} />
  const SelectPeoplePage = () => <Root pageComponent={SelectPeople} fbc={fbc} />

  return (
    <View style={s.container}>
      <TitleBar title={title} client={client} />
      <NavStackRouter path={path} extension="magichour">
        <View style={s.container}>
          <Route exact path="/" component={Main} />
          <Route exact path="/select" component={SelectPeoplePage} />
        </View>
      </NavStackRouter>
    </View>
  )
}

const SelectPeople = () => <Text>TODO: SELECT PEOPLE</Text>

class Root extends PureComponent {
  state = {
    allMeetings: [],
    attendeesWithTopics: {},
    meeting: { isLive: false },
    meetings: [],
    showSettings: false,
    startTime: null,
    slotCount: null,
    secondsBeforeMeetings: null,
    secondsPerMeeting: null,
    isWelcomeComplete: null,
  }

  constructor(props) {
    super(props)

    this.signin = props.fbc.signin()
    this.signin.catch(err => console.error(err))

    this.cachedUsers = {}
    getAsyncStorageValue(cachedUsersKey).then(users => {
      this.cachedUsers = { ...(users || {}), ...this.cachedUsers }
    })
    getAsyncStorageValue(welcomeCompleteKey).then(isWelcomeComplete =>
      this.setState({ isWelcomeComplete }),
    )
  }

  componentDidMount() {
    const { fbc } = this.props
    client.getPrimaryColor().then(primaryColor => this.setState({ primaryColor }))
    client.getCurrentUser().then(currentUser => {
      this.setState({ currentUser })
      this.signin.then(() => {
        this.getServerTime = serverTimeFactory(fbc.database.private.userRef('st'), ServerValue)

        const meetingsRef = fbc.database.public.allRef('meetings')

        fbc.database.public
          .adminRef('startTime')
          .on('value', data => this.setState({ startTime: data.val() }))

        fbc.database.public
          .adminRef('secondsBeforeMeetings')
          .on('value', data => this.setState({ secondsBeforeMeetings: data.val() || 120 }))
        fbc.database.public
          .adminRef('secondsPerMeeting')
          .on('value', data => this.setState({ secondsPerMeeting: data.val() || 300 }))
        fbc.database.public
          .adminRef('slotCount')
          .on('value', data => this.setState({ slotCount: data.val() || 12 }))

        fbc.database.public
          .adminRef('topics')
          .on('value', data => this.setState({ topics: [null, ...(data.val() || '').split('\n')] }))
        fbc.database.public
          .adminRef('requireIsHere')
          .on('value', data => this.setState({ requireIsHere: data.val() || false }))

        meetingsRef.on('child_added', data => {
          const meeting = { ...data.val(), id: data.key }
          this.setState(({ allMeetings }) => ({ allMeetings: [...allMeetings, meeting] }))
          if (meeting.a === currentUser.id || meeting.b === currentUser.id) {
            const otherId = meeting.a === currentUser.id ? meeting.b : meeting.a
            this.setState(({ meetings }) => ({
              meetings: setArrayAt(meetings.slice(), meeting.slotIndex, otherId),
            }))
          }
        })

        mapPushedDataToStateObjects(fbc.database.public.usersRef(), this, 'attendeesWithTopics')

        meetingsRef.on('child_removed', data => {
          const meeting = data.val()
          this.setState(({ allMeetings }) => ({
            allMeetings: allMeetings.filter(
              m => m.a !== meeting.a || m.b !== meeting.b || m.slotIndex !== meeting.slotIndex,
            ),
          }))
          if (meeting.a === currentUser.id || meeting.b === currentUser.id) {
            this.setState(({ meetings }) => ({
              meetings: setArrayAt(meetings.slice(), meeting.slotIndex, null),
            }))
          }
        })
      })

      // When debugging, the firebase signin Promise has to be coerced into resolving :/
      if (client._b.isEmulated)
        setTimeout(() => fbc.database.public.adminRef('junk').once('value'), 1000)
    })
  }

  componentDidUpdate(_, prevState) {
    if (
      prevState.startTime !== this.state.startTime ||
      prevState.slotCount !== this.state.slotCount ||
      prevState.secondsBeforeMeetings !== this.state.secondsBeforeMeetings ||
      prevState.secondsPerMeeting !== this.state.secondsPerMeeting
    ) {
      if (this.timer) clearTimeout(this.timer)
      this.setTimer()
    }
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer)
  }

  setTimer = () => {
    const meeting = getMeetingState(this.getServerTime, this.state) // eslint-disable-line react/no-access-state-in-setstate
    this.setState({ meeting })
    if (meeting.isLive) {
      const ms = Math.min(meeting.endTime - this.getServerTime(), 5000) // Check at least every 5 seconds.
      setTimeout(this.setTimer, ms)
    }
  }

  render() {
    const {
      allMeetings,
      attendeesWithTopics,
      currentUser,
      primaryColor,
      isWelcomeComplete,
      meeting,
      meetings,
      requireIsHere,
      secondsBeforeMeeting,
      secondsPerMeeting,
      slotCount,
      startTime,
      topics,
    } = this.state
    if (!currentUser || !primaryColor || slotCount == null || isWelcomeComplete == null)
      return <Loading />

    if (!isWelcomeComplete) {
      return (
        <Welcome
          dismiss={this.dismissWelcome}
          primaryColor={primaryColor}
          secondsPerMeeting={secondsPerMeeting}
          slotCount={slotCount}
        />
      )
    }

    const meetingWith = userId =>
      userId == null
        ? null
        : allMeetings.find(
            m =>
              (m.a === currentUser.id && m.b === userId) ||
              (m.b === currentUser.id && m.a === userId),
          )

    const currentMeetingUserId = meeting.isLive ? meetings[meeting.roundIndex] : null
    const currentMeeting = meetingWith(currentMeetingUserId)

    const availableAttendees = Object.entries(attendeesWithTopics)
      .map(([id, attendee]) => ({
        ...attendee,
        ...this.getCachedUser(id),
        id,
        mutuallyAvailableSlots: this.mutuallyAvailableSlotIndexes(id),
      }))
      .filter(a => a.mutuallyAvailableSlots.length && a.id !== currentUser.id)

    const selectedAttendees = Object.entries(meetings)
      .filter(([, id]) => id)
      .sort(([i1], [i2]) => i1 - i2)
      .map(([, id]) => ({
        ...attendeesWithTopics[id],
        ...this.getCachedUser(id),
        id,
      }))

    let attendeesToList = availableAttendees

    if (requireIsHere) {
      attendeesToList = attendeesToList.filter(u => u.isHere)
    }

    const me = attendeesWithTopics[currentUser.id] || {}
    const topicsForMeeting = m => {
      if (!m) return []
      const a = attendeesWithTopics[m.a]
      const b = attendeesWithTopics[m.b]
      return [a && a.topic, b && b.topic].filter(x => x)
    }

    const { cachedUsers, fbc, pageComponent } = this.props
    const Page = pageComponent
    return (
      <Page
        fbc={fbc}
        cachedUsers={cachedUsers}
        currentUser={currentUser}
        primaryColor={primaryColor}
        me={me}
        meetings={meetings}
        saveTopic={this.saveTopic}
        secondsBeforeMeeting={secondsBeforeMeeting}
        secondsPerMeeting={secondsPerMeeting}
        slotCount={slotCount}
        startTime={startTime}
        topics={topics}
        requireIsHere={requireIsHere}
      />
    )
  }

  persistCachedUsers = debounce(() => setAsyncStorageValue(cachedUsersKey, this.cachedUsers), 5000)

  getCachedUser = id => {
    let cached = this.cachedUsers[id]
    const now = new Date().valueOf()

    // Refetch attendee in the background if too old.
    if (
      !cached ||
      !cached.fetched ||
      (cached.fetched + 1000 * 15 < now && !cached.found) ||
      cached.fetched + 1000 * 60 * 60 * 12 < now
    ) {
      // Cache a placeholder so we don't lookup the same user multiple times
      if (!cached) cached = { id }
      cached.fetched = now
      this.cachedUsers[id] = cached

      client.getAttendee(id).then(user => {
        this.cachedUsers[id] = { ...user, found: true, fetched: now }
        this.setState({ c: now })
        this.persistCachedUsers()
      })
    }
    return cached
  }

  dismissWelcome = () => {
    this.setState({ isWelcomeComplete: true })
    setAsyncStorageValue(welcomeCompleteKey, true)
  }

  saveTopic = ({ topic }) => {
    this.setState({ isTopicComplete: true, showSettings: false })
    this.props.fbc.database.public.userRef('topic').set(topic)
    setAsyncStorageValue(topicCompleteKey, true)
  }

  mutuallyAvailableSlotIndexes = otherId => {
    const { allMeetings, currentUser, slotCount } = this.state
    const ourMeetings = allMeetings.filter(
      m => m.a === currentUser.id || m.b === currentUser.id || m.a === otherId || m.b === otherId,
    )

    // If we already have a meeting set with this attendee, don't show that we can schedule another slot.
    if (
      ourMeetings.find(
        m =>
          (m.a === currentUser.id && m.b === otherId) ||
          (m.a === otherId && m.b === currentUser.id),
      )
    ) {
      return []
    }

    const available = []
    for (let i = 0; i < slotCount; ++i) {
      if (!ourMeetings.find(m => m.slotIndex === i)) available.push(i)
    }

    return available
  }
}

const cachedUsersKey = 'magichour_cachedUsers'
const welcomeCompleteKey = 'magichour_welcomeComplete'
const topicCompleteKey = 'magichour_topicComplete'

const getAsyncStorageValue = async key =>
  AsyncStorage.getItem(key).then(val => (val ? JSON.parse(val) : null))
const setAsyncStorageValue = async (key, value) => AsyncStorage.setItem(key, JSON.stringify(value))

const Loading = () => (
  <View style={s.loading}>
    <Text>Loading...</Text>
  </View>
)

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f8f8',
  },
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
})

export default provideFirebaseConnectorToReactComponent(
  client,
  'magichour',
  (props, fbc) => <HomeView {...props} fbc={fbc} />,
  PureComponent,
)

function setArrayAt(arr, index, value) {
  arr[index] = value
  return arr
}